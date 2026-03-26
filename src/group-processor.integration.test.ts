/**
 * Integration test: message -> group processor -> container runner (spawn mocked)
 * -> output parsing -> response to MockChannel.
 *
 * The REAL runContainerAgent from container-runner.ts runs end-to-end (sentinel
 * marker parsing, Zod validation, streaming callbacks). Only child_process.spawn
 * is mocked to inject a FakeContainerProcess that we control from the test side.
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
  CONTAINER_TIMEOUT: 5000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: "/tmp/nanoclaw-int-test-data",
  GROUPS_DIR: "/tmp/nanoclaw-int-test-groups",
  IDLE_TIMEOUT: 5000,
  INSTANCE_ID: "test1234",
  MAX_PROMPT_MESSAGES: 200,
  TIMEZONE: "UTC",
  TRIGGER_PATTERN: /^@Andy\b/i,
  getTriggerPattern: (trigger?: string) =>
    trigger
      ? new RegExp(`^${trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
      : /^@Andy\b/i,
}));

vi.mock("./config.js", () => mockConfig);

vi.mock("./runtime-paths.js", () => ({
  APP_DIR: "/tmp/nanoclaw-int-test-app",
  CONFIG_ROOT: "/tmp/nanoclaw-int-test-groups",
  DATA_DIR: "/tmp/nanoclaw-int-test-data",
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
  isAuthError: vi.fn(() => false),
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

import { spawn } from "child_process";
import { createGroupProcessor } from "./group-processor.js";
import { runContainerAgent } from "./container-runner.js";
import { _resetDedupForTests } from "./message-dedup.js";

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
        ...(overrides?.extraGroups as Record<string, unknown>),
      }) as Record<string, ReturnType<typeof makeTestGroup>>,
    channels: () => [channel],
    lastAgentTimestamp: () => lastAgentTs,
    setLastAgentTimestamp: (jid: string, cursor: { ts: string; id: string }) => {
      lastAgentTs[jid] = cursor;
    },
    sessions: () => sessions,
    setSession: vi.fn(async (_folder: string, sessionId: string) => {
      const folder = _folder;
      sessions[folder] = sessionId;
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
    getAllMessagesSince: vi.fn(async (): Promise<ReturnType<typeof makeTestMessage>[]> => []),
    getMessagesSince: vi.fn(
      async (): Promise<ReturnType<typeof makeTestMessage>[]> =>
        (overrides?.messages as ReturnType<typeof makeTestMessage>[]) ?? [],
    ),
    getAllTasks: vi.fn(async () => []),
    runContainerAgent: runContainerAgent as Parameters<
      typeof createGroupProcessor
    >[0]["runContainerAgent"],
    writeTasksSnapshot: vi.fn(),
    writeGroupsSnapshot: vi.fn(),
    getAvailableGroups: vi.fn(async () => []),
    readMcpServersConfig: (): ReturnType<
      Parameters<typeof createGroupProcessor>[0]["readMcpServersConfig"]
    > =>
      (overrides?.mcpServers as ReturnType<
        Parameters<typeof createGroupProcessor>[0]["readMcpServersConfig"]
      >) ?? undefined,
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

describe("group-processor integration (real container-runner pipeline)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetDedupForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("full pipeline: message -> processor -> container -> channel response", async () => {
    const msgs = [
      makeTestMessage("m1", "Hello agent!", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel } = createDeps({ messages: msgs });

    scheduleOutput([{ status: "success", result: "Hello from agent!" }]);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");

    // Advance timers so setTimeout inside scheduleOutput fires, and the
    // container timeout doesn't kill the process prematurely.
    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toBe(true);
    expect(channel.sentMessages).toEqual([{ jid: "group@test", text: "Hello from agent!" }]);
  });

  it("cursor advances after successful agent run", async () => {
    const msgs = [
      makeTestMessage("msg-100", "hi", "2024-06-01T00:00:05Z", { chat_jid: "group@test" }),
    ];
    const { deps, lastAgentTs } = createDeps({ messages: msgs });

    scheduleOutput([{ status: "success", result: "response" }]);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    expect(lastAgentTs["group@test"]).toEqual({ ts: "2024-06-01T00:00:05Z", id: "msg-100" });
  });

  it("cursor rolls back when agent errors with no output", async () => {
    const msgs = [
      makeTestMessage("msg-200", "hi", "2024-06-01T00:00:10Z", { chat_jid: "group@test" }),
    ];
    const { deps, lastAgentTs } = createDeps({ messages: msgs });
    // Set a previous cursor
    lastAgentTs["group@test"] = { ts: "old", id: "old-id" };

    // Container exits with error code and no output markers
    vi.mocked(spawn).mockImplementation((() => {
      latestFakeProcess = new FakeContainerProcess();
      latestFakeProcess.stdin.on("end", () => {
        setTimeout(() => {
          latestFakeProcess.emitStderr("fatal error occurred");
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
    // Cursor should roll back to the previous value
    expect(lastAgentTs["group@test"]).toEqual({ ts: "old", id: "old-id" });
  });

  it("trigger gating for non-main groups", async () => {
    const nonMainGroup = makeTestGroup("sidegroup", { requiresTrigger: undefined });
    const noTriggerMsgs = [
      makeTestMessage("m1", "just chatting", "2024-06-01T00:00:01Z", { chat_jid: "side@test" }),
    ];
    const triggerMsgs = [
      makeTestMessage("m2", "@Andy hello", "2024-06-01T00:00:02Z", { chat_jid: "side@test" }),
    ];

    // --- First: no trigger => container NOT spawned ---
    {
      const { deps } = createDeps();
      // Override to add the non-main group
      deps.registeredGroups = () => ({ "side@test": nonMainGroup });
      deps.getAllMessagesSince = vi.fn(async () => noTriggerMsgs);
      vi.mocked(spawn).mockClear();

      const processGroupMessages = createGroupProcessor(deps);
      const result = await processGroupMessages("side@test");
      expect(result).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    }

    // --- Second: with trigger => container IS spawned ---
    {
      const { deps, channel } = createDeps();
      deps.registeredGroups = () => ({ "side@test": nonMainGroup });
      deps.getAllMessagesSince = vi.fn(async () => triggerMsgs);

      scheduleOutput([{ status: "success", result: "I can help!" }]);

      const processGroupMessages = createGroupProcessor(deps);
      const resultPromise = processGroupMessages("side@test");
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;

      expect(result).toBe(true);
      expect(spawn).toHaveBeenCalled();
      expect(channel.sentMessages).toEqual([{ jid: "side@test", text: "I can help!" }]);
    }
  });

  it("multi-chunk streamed output delivers multiple messages", async () => {
    const msgs = [
      makeTestMessage("m1", "Tell me a lot", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel } = createDeps({ messages: msgs });

    scheduleOutput([
      { status: "success", result: "Part 1 of the answer" },
      { status: "success", result: "Part 2 of the answer" },
      { status: "success", result: null },
    ]);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    // Two messages with text content (null result is a session-update marker, no send)
    expect(channel.sentMessages).toHaveLength(2);
    expect(channel.sentMessages[0]).toEqual({ jid: "group@test", text: "Part 1 of the answer" });
    expect(channel.sentMessages[1]).toEqual({ jid: "group@test", text: "Part 2 of the answer" });
  });

  it("session ID tracked from container output", async () => {
    const msgs = [
      makeTestMessage("m1", "start session", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, sessions } = createDeps({ messages: msgs });

    scheduleOutput([{ status: "success", result: "Session started", newSessionId: "session-abc" }]);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    expect(sessions["main"]).toBe("session-abc");
    expect(deps.setSession).toHaveBeenCalledWith("main", "session-abc");
  });

  it("internal tags stripped from output", async () => {
    const msgs = [
      makeTestMessage("m1", "question", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel } = createDeps({ messages: msgs });

    scheduleOutput([
      { status: "success", result: "<internal>thinking...</internal>The answer is 42" },
    ]);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    expect(channel.sentMessages).toEqual([{ jid: "group@test", text: "The answer is 42" }]);
  });

  it("typing indicator set and cleared", async () => {
    const msgs = [
      makeTestMessage("m1", "hello", "2024-06-01T00:00:01Z", { chat_jid: "group@test" }),
    ];
    const { deps, channel } = createDeps({ messages: msgs });

    // Track typing state transitions over time
    const typingHistory: boolean[] = [];
    const originalSetTyping = channel.setTyping.bind(channel);
    channel.setTyping = async (jid: string, isTyping: boolean) => {
      typingHistory.push(isTyping);
      await originalSetTyping(jid, isTyping);
    };

    scheduleOutput([{ status: "success", result: "done" }]);

    const processGroupMessages = createGroupProcessor(deps);
    const resultPromise = processGroupMessages("group@test");
    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    // typing should have been set to true then false
    expect(typingHistory).toEqual([true, false]);
    // Final state should be false
    expect(channel.typingState.get("group@test")).toBe(false);
  });
});
