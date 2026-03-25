import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _initTestDatabase, createTask, getTaskById } from "./db.js";
import { isAuthError } from "./auth-circuit-breaker.js";
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
  type SchedulerDependencies,
} from "./task-scheduler.js";

vi.mock("./container-runner.js", () => ({
  writeTasksSnapshot: vi.fn(),
}));

vi.mock("./auth-circuit-breaker.js", () => ({
  isAuthError: vi.fn(() => false),
}));

vi.mock("./message-dedup.js", () => ({
  shouldSend: vi.fn(() => true),
  recordSent: vi.fn(),
}));

vi.mock("./group-folder.js", async () => {
  const actual = await vi.importActual<typeof import("./group-folder.js")>("./group-folder.js");
  return {
    ...actual,
    resolveGroupFolderPath: vi.fn((folder: string) => {
      if (folder.includes("..")) throw new Error(`Invalid group folder "${folder}"`);
      return `/tmp/test-groups/${folder}`;
    }),
  };
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, default: { ...actual, mkdirSync: vi.fn() } };
});

const TEST_GROUP = {
  name: "Test",
  folder: "test-group",
  trigger: "@Andy",
  added_at: "2024-01-01",
};

function makeTask(
  overrides?: Partial<import("./types.js").ScheduledTask>,
): import("./types.js").ScheduledTask {
  return {
    id: "task-1",
    group_folder: "test-group",
    chat_jid: "group@g.us",
    prompt: "run daily check",
    schedule_type: "once",
    schedule_value: "2026-02-22T00:00:00.000Z",
    context_mode: "isolated",
    next_run: new Date(Date.now() - 60_000).toISOString(),
    last_run: null,
    last_result: null,
    status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createMockDeps(overrides?: Partial<SchedulerDependencies>): SchedulerDependencies {
  return {
    registeredGroups: () => ({ "group@g.us": TEST_GROUP }),
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
    runAgent: vi.fn(async () => ({ status: "success" as const, result: null })),
    ...overrides,
  };
}

describe("task scheduler", () => {
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

  it("pauses due tasks with invalid group folders to prevent retry churn", async () => {
    await createTask({
      id: "task-invalid-folder",
      group_folder: "../../outside",
      chat_jid: "bad@g.us",
      prompt: "run",
      schedule_type: "once",
      schedule_value: "2026-02-22T00:00:00.000Z",
      context_mode: "isolated",
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: "active",
      created_at: "2026-02-22T00:00:00.000Z",
    });

    const deps = createMockDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    const task = await getTaskById("task-invalid-folder");
    expect(task?.status).toBe("paused");
  });

  it("computeNextRun anchors interval tasks to scheduled time to prevent drift", () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: "60000",
      next_run: scheduledTime,
    });

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it("computeNextRun returns null for once-tasks", () => {
    expect(computeNextRun(makeTask())).toBeNull();
  });

  it("computeNextRun with cron type returns valid future date", () => {
    const task = makeTask({ schedule_type: "cron", schedule_value: "0 9 * * *" });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("computeNextRun with NaN interval returns 60s fallback", () => {
    const task = makeTask({ schedule_type: "interval", schedule_value: "not-a-number" });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const delta = new Date(nextRun!).getTime() - Date.now();
    expect(delta).toBeGreaterThanOrEqual(59000);
    expect(delta).toBeLessThanOrEqual(61000);
  });

  it("computeNextRun with zero interval returns 60s fallback", () => {
    const task = makeTask({ schedule_type: "interval", schedule_value: "0" });
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const delta = new Date(nextRun!).getTime() - Date.now();
    expect(delta).toBeGreaterThanOrEqual(59000);
    expect(delta).toBeLessThanOrEqual(61000);
  });

  it("computeNextRun skips missed intervals without infinite loop", () => {
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();
    const task = makeTask({
      schedule_type: "interval",
      schedule_value: String(ms),
      next_run: scheduledTime,
    });

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    const offset = (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

describe("runTask via startSchedulerLoop", () => {
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

  async function runOneTask(
    taskOverrides?: Partial<import("./types.js").ScheduledTask>,
    depsOverrides?: Partial<SchedulerDependencies>,
  ) {
    const task = makeTask(taskOverrides);
    await createTask(task);
    const deps = createMockDeps(depsOverrides);
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);
    return { task, deps };
  }

  it("runs agent successfully and logs result", async () => {
    const { deps } = await runOneTask();
    expect(deps.runAgent).toHaveBeenCalled();
    const task = await getTaskById("task-1");
    // Once task should be completed
    expect(task?.status).toBe("completed");
  });

  it("logs error when group not found", async () => {
    const { deps } = await runOneTask(
      { group_folder: "nonexistent" },
      { registeredGroups: () => ({ "group@g.us": { ...TEST_GROUP, folder: "other" } }) },
    );
    // Agent should not be called when group is not found
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it("sends streamed output to channel", async () => {
    const sendMessage = vi.fn(async () => {});
    await runOneTask(undefined, {
      sendMessage,
      runAgent: vi.fn(async (_g, _i, _p, onOutput) => {
        await onOutput!({ status: "success", result: "Task done!" });
        return { status: "success" as const, result: "Task done!" };
      }),
    });
    expect(sendMessage).toHaveBeenCalledWith("group@g.us", "Task done!");
  });

  it("suppresses auth error in streamed output", async () => {
    vi.mocked(isAuthError).mockReturnValue(true);

    const sendMessage = vi.fn(async () => {});
    await runOneTask(undefined, {
      sendMessage,
      runAgent: vi.fn(async (_g, _i, _p, onOutput) => {
        await onOutput!({ status: "success", result: "auth error text" });
        return { status: "success" as const, result: "auth error text" };
      }),
    });
    // Auth error result is suppressed — sendMessage not called for the output.
    // (Auto-pause only fires on error status, not successful-with-auth-error-result)
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("handles agent error status", async () => {
    await runOneTask(undefined, {
      runAgent: vi.fn(async () => ({
        status: "error" as const,
        result: null,
        error: "container failed",
      })),
    });
    const task = await getTaskById("task-1");
    expect(task?.last_result).toContain("Error:");
  });

  it("handles agent exception", async () => {
    await runOneTask(undefined, {
      runAgent: vi.fn(async () => {
        throw new Error("docker not running");
      }),
    });
    const task = await getTaskById("task-1");
    expect(task?.last_result).toContain("Error: docker not running");
  });

  it("uses session ID for group context mode", async () => {
    const { deps } = await runOneTask(
      { context_mode: "group" },
      { getSessions: () => ({ "test-group": "session-abc" }) },
    );
    const call = vi.mocked(deps.runAgent).mock.calls[0];
    expect(call[1].sessionId).toBe("session-abc");
  });

  it("does not use session ID for isolated context mode", async () => {
    const { deps } = await runOneTask(
      { context_mode: "isolated" },
      { getSessions: () => ({ "test-group": "session-abc" }) },
    );
    const call = vi.mocked(deps.runAgent).mock.calls[0];
    expect(call[1].sessionId).toBeUndefined();
  });

  it("auto-pauses on auth error", async () => {
    vi.mocked(isAuthError).mockImplementation((text: string) => text.includes("auth"));

    const sendMessage = vi.fn(async () => {});
    await runOneTask(undefined, {
      sendMessage,
      runAgent: vi.fn(async () => ({
        status: "error" as const,
        result: null,
        error: "auth token expired",
      })),
    });
    const task = await getTaskById("task-1");
    expect(task?.status).toBe("paused");
    expect(sendMessage).toHaveBeenCalledWith(
      "group@g.us",
      expect.stringContaining("paused due to authentication failure"),
    );
  });

  it("computes next run for recurring tasks", async () => {
    await runOneTask({
      id: "recurring-task",
      schedule_type: "interval",
      schedule_value: "60000",
    });
    const task = await getTaskById("recurring-task");
    expect(task?.next_run).not.toBeNull();
    expect(task?.status).toBe("active");
  });

  it("writes tasks snapshot before running agent", async () => {
    const { writeTasksSnapshot } = await import("./container-runner.js");
    await runOneTask();
    expect(writeTasksSnapshot).toHaveBeenCalled();
  });

  it("notifies queue idle on success", async () => {
    const deps = createMockDeps({
      runAgent: vi.fn(async (_g, _i, _p, onOutput) => {
        await onOutput!({ status: "success", result: null });
        return { status: "success" as const, result: null };
      }),
    });
    await createTask(makeTask());
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);
    expect(deps.queue.notifyIdle).toHaveBeenCalledWith("group@g.us");
  });
});
