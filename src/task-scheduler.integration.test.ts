/**
 * Integration tests for the task scheduler.
 *
 * What's real:
 * - startSchedulerLoop, computeNextRun, _resetSchedulerLoopForTests
 * - _initTestDatabase() — real in-memory SQLite
 * - All DB operations: createTask, getTaskById, getDueTasks, updateTaskAfterRun, logTaskRun
 *
 * What's mocked:
 * - deps.runAgent — configurable mock (scheduler receives it via SchedulerDependencies)
 * - writeTasksSnapshot — mocked (writes to IPC dirs that don't exist in tests)
 * - fs.mkdirSync — mocked (runTask calls it on the group dir)
 * - logger, auth-circuit-breaker, message-dedup, group-folder — mocked
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isAuthError } from "./auth-circuit-breaker.js";
import { _initTestDatabase, createTask, getTaskById } from "./db.js";
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
  type SchedulerDependencies,
} from "./task-scheduler.js";
import { makeTestGroup } from "./test-utils/integration-helpers.js";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("./config.js", () => ({
  ASSISTANT_NAME: "Andy",
  SCHEDULER_POLL_INTERVAL: 100,
  TIMEZONE: "UTC",
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("./container-runner.js", () => ({
  writeTasksSnapshot: vi.fn(),
}));

vi.mock("./message-dedup.js", () => ({
  shouldSend: vi.fn(() => true),
  recordSent: vi.fn(),
}));

vi.mock("./auth-circuit-breaker.js", () => ({
  isAuthError: vi.fn(() => false),
}));

vi.mock("./group-folder.js", () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/groups/${folder}`),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, default: { ...actual, mkdirSync: vi.fn() } };
});

// ── Helpers ─────────────────────────────────────────────────────────

const TEST_GROUP = makeTestGroup("test-group");

function createMockDeps(overrides?: Partial<SchedulerDependencies>): SchedulerDependencies {
  return {
    registeredGroups: () => ({
      "group@test": TEST_GROUP,
    }),
    getSessions: () => ({}),
    queue: {
      enqueueTask: vi.fn((_jid: string, _id: string, fn: () => Promise<void>) => {
        void fn();
      }),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
    } as any,
    onProcess: vi.fn(),
    sendMessage: vi.fn(async () => {}),
    readMcpServersConfig: () => undefined,
    runAgent: vi.fn(async (_group, _input, _onProcess, onOutput) => {
      if (onOutput) {
        await onOutput({ status: "success", result: null });
      }
      return { status: "success" as const, result: null };
    }),
    ...overrides,
  };
}

function makeTaskInput(overrides?: Record<string, unknown>) {
  return {
    id: "task-1",
    group_folder: "test-group",
    chat_jid: "group@test",
    prompt: "run daily check",
    schedule_type: "interval" as const,
    schedule_value: "60000",
    context_mode: "isolated" as const,
    next_run: new Date(Date.now() - 60_000).toISOString(),
    status: "active" as const,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("task-scheduler integration", () => {
  beforeEach(async () => {
    await _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("due task triggers agent run and logs success in DB", async () => {
    await createTask(makeTaskInput());

    const deps = createMockDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(150);

    // Agent was invoked with correct group and prompt
    expect(deps.runAgent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(deps.runAgent).mock.calls[0];
    expect(call[0].folder).toBe("test-group");
    expect(call[1].prompt).toBe("run daily check");
    expect(call[1].isScheduledTask).toBe(true);
    expect(call[1].assistantName).toBe("Andy");

    // Task is still active (recurring interval task)
    const task = await getTaskById("task-1");
    expect(task).toBeDefined();
    expect(task!.status).toBe("active");
    expect(task!.last_result).not.toBeNull();
  });

  it("recurring interval task gets next_run updated after run", async () => {
    const pastRun = new Date(Date.now() - 60_000).toISOString();
    await createTask(
      makeTaskInput({
        schedule_type: "interval",
        schedule_value: "60000",
        next_run: pastRun,
      }),
    );

    const deps = createMockDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(150);

    const task = await getTaskById("task-1");
    expect(task).toBeDefined();
    expect(task!.next_run).not.toBeNull();
    // next_run should be in the future (anchored to scheduled time + interval)
    expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(Date.now());
    // Verify it's anchored: should be pastRun + N*60000
    const offset = (new Date(task!.next_run!).getTime() - new Date(pastRun).getTime()) % 60000;
    expect(offset).toBe(0);
  });

  it("once task gets completed status after run", async () => {
    await createTask(
      makeTaskInput({
        id: "once-task",
        schedule_type: "once",
        schedule_value: "2026-02-22T00:00:00.000Z",
      }),
    );

    const deps = createMockDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(150);

    const task = await getTaskById("once-task");
    expect(task).toBeDefined();
    // computeNextRun returns null for once tasks → updateTaskAfterRun sets status to "completed"
    expect(task!.next_run).toBeNull();
    expect(task!.status).toBe("completed");
  });

  it("auth error auto-pauses task and sends notification", async () => {
    vi.mocked(isAuthError).mockImplementation(
      (text: string) => text.toLowerCase().includes("unauthorized") || text.includes("401"),
    );

    const sendMessage = vi.fn(async () => {});
    await createTask(makeTaskInput({ id: "auth-task" }));

    const deps = createMockDeps({
      sendMessage,
      runAgent: vi.fn(async () => ({
        status: "error" as const,
        result: null,
        error: "401 Unauthorized",
      })),
    });

    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(150);

    const task = await getTaskById("auth-task");
    expect(task).toBeDefined();
    expect(task!.status).toBe("paused");

    // Notification sent to the chat
    expect(sendMessage).toHaveBeenCalledWith(
      "group@test",
      expect.stringContaining("paused due to authentication failure"),
    );
  });

  it("container error logged but task not paused (non-auth error)", async () => {
    await createTask(makeTaskInput({ id: "error-task" }));

    const sendMessage = vi.fn(async () => {});
    const deps = createMockDeps({
      sendMessage,
      runAgent: vi.fn(async () => ({
        status: "error" as const,
        result: null,
        error: "Container crashed",
      })),
    });

    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(150);

    const task = await getTaskById("error-task");
    expect(task).toBeDefined();
    // Non-auth error: task stays active (with updated next_run for recurring)
    expect(task!.status).toBe("active");
    // Error is recorded in last_result
    expect(task!.last_result).toContain("Error: Container crashed");
    // No pause notification sent (sendMessage only called if streamed output has result)
    expect(sendMessage).not.toHaveBeenCalledWith("group@test", expect.stringContaining("paused"));
  });

  it("streamed output delivered to sendMessage", async () => {
    const sendMessage = vi.fn(async () => {});
    await createTask(makeTaskInput({ id: "stream-task" }));

    const deps = createMockDeps({
      sendMessage,
      runAgent: vi.fn(async (_group, _input, _onProcess, onOutput) => {
        await onOutput!({ status: "success", result: "Task result text" });
        return { status: "success" as const, result: "Task result text" };
      }),
    });

    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(150);

    expect(sendMessage).toHaveBeenCalledWith("group@test", "Task result text");
  });

  it("paused task skipped by scheduler", async () => {
    await createTask(
      makeTaskInput({
        id: "paused-task",
        status: "paused",
        next_run: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    const deps = createMockDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(150);

    // getDueTasks only returns active tasks, so runAgent should not be called
    expect(deps.runAgent).not.toHaveBeenCalled();
  });
});
