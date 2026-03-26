/**
 * Integration test: error handling paths across module boundaries.
 *
 * Tests malformed output, container crashes, timeouts, Zod validation
 * failures, cursor rollback, PartialSendError, and auth circuit breaker
 * interaction. Same mock strategy as group-processor.integration.test.ts:
 * only child_process.spawn and fs are mocked; real code runs in
 * group-processor, container-runner, message-processing, and router.
 */
import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks (must precede all other vi.mock calls) ─────────────

const mockConfig = vi.hoisted(() => ({
  ASSISTANT_NAME: "Andy",
  CONTAINER_CPU_LIMIT: "2",
  CONTAINER_HOST_CONFIG_DIR: "",
  CONTAINER_HOST_DATA_DIR: "",
  CONTAINER_IMAGE: "nanoclaw-agent:latest",
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_MEMORY_LIMIT: "4g",
  CONTAINER_TIMEOUT: 2000, // Short for timeout tests
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: "/tmp/nanoclaw-err-test-data",
  GROUPS_DIR: "/tmp/nanoclaw-err-test-groups",
  IDLE_TIMEOUT: 2000,
  INSTANCE_ID: "test1234",
  MAX_PROMPT_MESSAGES: 200,
  TIMEZONE: "UTC",
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock("./config.js", () => mockConfig);

vi.mock("./runtime-paths.js", () => ({
  APP_DIR: "/tmp/nanoclaw-err-test-app",
  CONFIG_ROOT: "/tmp/nanoclaw-err-test-groups",
  DATA_DIR: "/tmp/nanoclaw-err-test-data",
}));

vi.mock("./container-runtime.js", () => ({
  CREDENTIAL_PROXY_EXTERNAL_URL: "",
  AGENT_NETWORK: "",
  CONTAINER_HOST_GATEWAY: "host.docker.internal",
  CONTAINER_RUNTIME_BIN: "docker",
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => [
    "--mount",
    `type=bind,source=${h},target=${c},readonly`,
  ],
  stopContainer: (name: string) => `docker stop ${name}`,
}));

vi.mock("./credential-proxy.js", () => ({
  detectAuthMode: () => "api-key",
  registerContainerToken: vi.fn(),
  deregisterContainerToken: vi.fn(),
}));

vi.mock("./auth-circuit-breaker.js", () => ({
  isAuthError: vi.fn(
    (text: string) =>
      text.toLowerCase().includes("401") || text.toLowerCase().includes("unauthorized"),
  ),
  recordAuthFailure: vi.fn(),
  recordAuthSuccess: vi.fn(),
}));

vi.mock("./mount-security.js", () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock("./logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./message-dedup.js", () => ({
  shouldSend: vi.fn(() => true),
  recordSent: vi.fn(),
  _resetDedupForTests: vi.fn(),
}));

vi.mock("./sender-allowlist.js", () => ({
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: "*", mode: "trigger" },
    chats: {},
    logDenied: false,
  })),
  isTriggerAllowed: vi.fn(() => true),
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ""),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      chownSync: vi.fn(),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// ── child_process mock — captures every spawn into latestFakeProcess ──

import {
  FakeContainerProcess,
  MockChannel,
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
  makeTestGroup,
  makeTestMessage,
} from "./test-utils/integration-helpers.js";

let latestFakeProcess: FakeContainerProcess;

vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    latestFakeProcess = new FakeContainerProcess();
    return latestFakeProcess;
  }),
  exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
    if (cb) cb(null);
    return new EventEmitter();
  }),
}));

// ── Imports (must come AFTER mocks) ──────────────────────────────────

import { exec, spawn } from "child_process";
import { createGroupProcessor } from "./group-processor.js";
import { runContainerAgent } from "./container-runner.js";
import { _resetDedupForTests } from "./message-dedup.js";
import { recordAuthFailure } from "./auth-circuit-breaker.js";
import { PartialSendError } from "./types.js";
import { logger } from "./logger.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createDeps(overrides?: Record<string, unknown>) {
  const channel = new MockChannel({
    jidPattern: (jid) => jid.endsWith("@test"),
  });
  const lastAgentTs: Record<string, { ts: string; id: string }> = {};
  const sessions: Record<string, string> = {};
  const pendingTailDrain = new Map<string, { ts: string; id: string }>();
  const mainGroup = makeTestGroup("main", { isMain: true });

  const deps = {
    registeredGroups: () =>
      ({
        "group@test": mainGroup,
      }) as Record<string, ReturnType<typeof makeTestGroup>>,
    channels: () => [channel],
    lastAgentTimestamp: () => lastAgentTs,
    setLastAgentTimestamp: (jid: string, cursor: { ts: string; id: string }) => {
      lastAgentTs[jid] = cursor;
    },
    sessions: () => sessions,
    setSession: vi.fn(async (_folder: string, sessionId: string) => {
      sessions[_folder] = sessionId;
    }),
    pendingTailDrain: () => pendingTailDrain,
    saveState: vi.fn(async () => {}),
    savePendingTailDrain: vi.fn(async () => {}),
    queue: {
      enqueueMessageCheck: vi.fn(),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
      registerProcess: vi.fn(),
    },
    getAllMessagesSince: vi.fn(async () => []),
    getMessagesSince: vi.fn(
      async () => (overrides?.messages as ReturnType<typeof makeTestMessage>[]) ?? [],
    ),
    getAllTasks: vi.fn(async () => []),
    runContainerAgent: runContainerAgent as Parameters<
      typeof createGroupProcessor
    >[0]["runContainerAgent"],
    writeTasksSnapshot: vi.fn(),
    writeGroupsSnapshot: vi.fn(),
    getAvailableGroups: vi.fn(async () => []),
    readMcpServersConfig: () => undefined,
  };

  return { deps, channel, lastAgentTs, sessions, pendingTailDrain };
}

/**
 * Schedule fake container output after stdin.end() is called.
 * container-runner writes to stdin synchronously after spawn,
 * so we hook stdin "end" to know when to emit our response.
 */
function scheduleOutput(
  outputs: Array<{
    status: "success" | "error";
    result?: string | null;
    newSessionId?: string;
    error?: string;
  }>,
  exitCode = 0,
) {
  vi.mocked(spawn).mockImplementation((() => {
    latestFakeProcess = new FakeContainerProcess();
    latestFakeProcess.stdin.on("end", () => {
      setTimeout(() => {
        for (const output of outputs) {
          latestFakeProcess.emitOutput(output);
        }
        latestFakeProcess.close(exitCode);
      }, 5);
    });
    return latestFakeProcess;
  }) as unknown as typeof spawn);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("error paths integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetDedupForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("malformed JSON between sentinel markers returns error status", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel } = createDeps({ messages: msgs });

    // Emit sentinel markers wrapping invalid JSON, then close successfully
    vi.mocked(spawn).mockImplementation((() => {
      latestFakeProcess = new FakeContainerProcess();
      latestFakeProcess.stdin.on("end", () => {
        setTimeout(() => {
          latestFakeProcess.stdout.push(`${OUTPUT_START_MARKER}\nnot json\n${OUTPUT_END_MARKER}\n`);
          latestFakeProcess.close(0);
        }, 5);
      });
      return latestFakeProcess;
    }) as unknown as typeof spawn);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    // Container exited 0 so runContainerAgent resolves with status "success",
    // but the malformed JSON was not delivered as a message.
    expect(result).toBe(true);
    expect(channel.sentMessages).toHaveLength(0);
    // The streaming parser logged a warning about the parse failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ group: "Main" }),
      expect.stringContaining("Failed to parse streamed output chunk"),
    );
  });

  it("container exit code non-zero triggers error and records auth failure", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, lastAgentTs } = createDeps({ messages: msgs });
    lastAgentTs["group@test"] = { ts: "old", id: "old-id" };

    // Container emits stderr with auth error then exits non-zero
    vi.mocked(spawn).mockImplementation((() => {
      latestFakeProcess = new FakeContainerProcess();
      latestFakeProcess.stdin.on("end", () => {
        setTimeout(() => {
          latestFakeProcess.emitStderr("Error: 401 Unauthorized\n");
          latestFakeProcess.close(1);
        }, 5);
      });
      return latestFakeProcess;
    }) as unknown as typeof spawn);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toBe(false);
    // recordAuthFailure called because stderr contained "401"
    expect(recordAuthFailure).toHaveBeenCalled();
    // Cursor rolled back because no output was sent to user
    expect(lastAgentTs["group@test"]).toEqual({ ts: "old", id: "old-id" });
  });

  it("container timeout with no output returns error", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, lastAgentTs } = createDeps({ messages: msgs });
    lastAgentTs["group@test"] = { ts: "old", id: "old-id" };

    // Container never emits output and never closes on its own
    vi.mocked(spawn).mockImplementation((() => {
      latestFakeProcess = new FakeContainerProcess();
      // Do nothing on stdin end — simulate a stuck container
      return latestFakeProcess;
    }) as unknown as typeof spawn);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");

    // The timeout is max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30000).
    // CONTAINER_TIMEOUT=2000, IDLE_TIMEOUT=2000, so effective = max(2000, 32000) = 32000.
    // Advance past that to trigger the timeout handler.
    await vi.advanceTimersByTimeAsync(33000);

    // exec (stopContainer) should have been called
    expect(exec).toHaveBeenCalledWith(
      expect.stringContaining("docker stop"),
      expect.anything(),
      expect.any(Function),
    );

    // Now simulate the container closing after being stopped
    latestFakeProcess.stdout.push(null);
    latestFakeProcess.stderr.push(null);
    latestFakeProcess.emit("close", 137);

    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    expect(result).toBe(false);
    // Cursor should be rolled back (no output sent)
    expect(lastAgentTs["group@test"]).toEqual({ ts: "old", id: "old-id" });
  });

  it("container timeout after streaming output treated as success", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel, lastAgentTs } = createDeps({ messages: msgs });

    // Container emits output, then never closes
    vi.mocked(spawn).mockImplementation((() => {
      latestFakeProcess = new FakeContainerProcess();
      latestFakeProcess.stdin.on("end", () => {
        setTimeout(() => {
          latestFakeProcess.emitOutput({ status: "success", result: "Here is your answer" });
          // Deliberately do NOT close — simulate a stuck container after output
        }, 5);
      });
      return latestFakeProcess;
    }) as unknown as typeof spawn);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");

    // Let the output emit
    await vi.advanceTimersByTimeAsync(50);

    // Output resets the timeout, so we need to advance past the
    // timeout again from the reset point. Advance past effective timeout.
    await vi.advanceTimersByTimeAsync(33000);

    // exec (stopContainer) should have been called
    expect(exec).toHaveBeenCalled();

    // Simulate container closing after stop
    latestFakeProcess.stdout.push(null);
    latestFakeProcess.stderr.push(null);
    latestFakeProcess.emit("close", 0);

    await vi.advanceTimersByTimeAsync(50);
    const result = await resultPromise;

    // Success because output was already streamed
    expect(result).toBe(true);
    expect(channel.sentMessages).toEqual([{ jid: "group@test", text: "Here is your answer" }]);
    // Cursor should NOT be rolled back
    expect(lastAgentTs["group@test"]).toEqual({ ts: "2024-06-01T00:00:01Z", id: "m1" });
  });

  it("container output fails Zod validation (invalid status field)", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel } = createDeps({ messages: msgs });

    // Emit well-formed JSON with an invalid status value
    vi.mocked(spawn).mockImplementation((() => {
      latestFakeProcess = new FakeContainerProcess();
      latestFakeProcess.stdin.on("end", () => {
        setTimeout(() => {
          const invalidOutput = JSON.stringify({ status: "unknown", result: "test" });
          latestFakeProcess.stdout.push(
            `${OUTPUT_START_MARKER}\n${invalidOutput}\n${OUTPUT_END_MARKER}\n`,
          );
          latestFakeProcess.close(0);
        }, 5);
      });
      return latestFakeProcess;
    }) as unknown as typeof spawn);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    // Container exited 0 but invalid output was not delivered
    expect(result).toBe(true);
    expect(channel.sentMessages).toHaveLength(0);
    // Schema validation warning should be logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ group: "Main", issues: expect.any(Array) }),
      expect.stringContaining("Container output failed schema validation"),
    );
  });

  it("channel sendMessage throws — cursor rolled back", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel, lastAgentTs } = createDeps({ messages: msgs });
    lastAgentTs["group@test"] = { ts: "old", id: "old-id" };

    // Configure channel to throw on sendMessage
    channel.sendMessageImpl = async () => {
      throw new Error("Discord API error");
    };

    scheduleOutput([{ status: "success", result: "Agent response" }]);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    // Should fail because send failed and no output reached user
    expect(result).toBe(false);
    // Cursor rolled back to previous value
    expect(lastAgentTs["group@test"]).toEqual({ ts: "old", id: "old-id" });
  });

  it("PartialSendError — cursor NOT rolled back", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel, lastAgentTs } = createDeps({ messages: msgs });
    lastAgentTs["group@test"] = { ts: "old", id: "old-id" };

    // Configure channel to throw PartialSendError (some chunks delivered)
    channel.sendMessageImpl = async () => {
      throw new PartialSendError("Partial delivery failure", 1, 3);
    };

    scheduleOutput([{ status: "success", result: "Agent response" }]);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    // Should succeed because partial output was sent (outputSentToUser = true)
    expect(result).toBe(true);
    // Cursor NOT rolled back — partial send means user saw some output
    expect(lastAgentTs["group@test"]).toEqual({ ts: "2024-06-01T00:00:01Z", id: "m1" });
  });

  it("container spawn error event returns graceful error", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel, lastAgentTs } = createDeps({ messages: msgs });
    lastAgentTs["group@test"] = { ts: "old", id: "old-id" };

    // Spawn returns a process that immediately emits an error
    vi.mocked(spawn).mockImplementation((() => {
      latestFakeProcess = new FakeContainerProcess();
      // Emit error after a tick (after container-runner sets up listeners)
      setTimeout(() => {
        latestFakeProcess.emit("error", new Error("docker not found"));
      }, 5);
      return latestFakeProcess;
    }) as unknown as typeof spawn);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    // Error path: no output sent to user
    expect(result).toBe(false);
    expect(channel.sentMessages).toHaveLength(0);
    // Cursor should be rolled back
    expect(lastAgentTs["group@test"]).toEqual({ ts: "old", id: "old-id" });
  });

  it("OOM exit code 137 with memory limit logs warning", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps } = createDeps({ messages: msgs });

    // Container exits with code 137 (SIGKILL, typically OOM)
    vi.mocked(spawn).mockImplementation((() => {
      latestFakeProcess = new FakeContainerProcess();
      latestFakeProcess.stdin.on("end", () => {
        setTimeout(() => {
          latestFakeProcess.close(137);
        }, 5);
      });
      return latestFakeProcess;
    }) as unknown as typeof spawn);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    // Should log a warning about possible OOM
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ group: "Main", memoryLimit: "4g" }),
      expect.stringContaining("consider increasing"),
    );
  });
});
