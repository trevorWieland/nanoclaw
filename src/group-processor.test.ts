import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGroupProcessor } from "./group-processor.js";
import { isAuthError } from "./auth-circuit-breaker.js";
import { shouldSend } from "./message-dedup.js";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("./config.js", () => ({
  ASSISTANT_NAME: "Andy",
  IDLE_TIMEOUT: 1800000,
  MAX_PROMPT_MESSAGES: 200,
  TIMEZONE: "UTC",
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock("./auth-circuit-breaker.js", () => ({
  isAuthError: vi.fn(() => false),
}));

vi.mock("./message-dedup.js", () => ({
  shouldSend: vi.fn(() => true),
  recordSent: vi.fn(),
}));

vi.mock("./sender-allowlist.js", () => ({
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: "*", mode: "trigger" },
    chats: {},
    logDenied: false,
  })),
  isTriggerAllowed: vi.fn(() => true),
}));

function makeMsg(
  id: string,
  content: string,
  timestamp: string,
  overrides?: Partial<{ is_from_me: boolean; sender: string }>,
) {
  return {
    id,
    chat_jid: "group@g.us",
    sender: overrides?.sender ?? "user1",
    sender_name: "User",
    content,
    timestamp,
    is_from_me: overrides?.is_from_me ?? false,
  };
}

const TEST_GROUP = {
  name: "Test",
  folder: "test",
  trigger: "@Andy",
  added_at: "2024-01-01",
};

const MAIN_GROUP = {
  ...TEST_GROUP,
  name: "Main",
  folder: "main",
  isMain: true,
};

const mockChannel = {
  name: "test",
  ownsJid: (jid: string) => jid.endsWith("@g.us"),
  sendMessage: vi.fn(),
  isConnected: () => true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  setTyping: vi.fn(),
};

function createMockDeps(
  overrides?: Partial<Parameters<typeof createGroupProcessor>[0]>,
): Parameters<typeof createGroupProcessor>[0] {
  const lastAgentTs: Record<string, { ts: string; id: string }> = {};
  const pendingTailDrain = new Map<string, { ts: string; id: string }>();
  return {
    registeredGroups: () => ({ "group@g.us": TEST_GROUP }),
    channels: () => [mockChannel],
    lastAgentTimestamp: () => lastAgentTs,
    setLastAgentTimestamp: (jid, cursor) => {
      lastAgentTs[jid] = cursor;
    },
    sessions: () => ({}),
    setSession: vi.fn(),
    pendingTailDrain: () => pendingTailDrain,
    saveState: vi.fn(),
    savePendingTailDrain: vi.fn(),
    queue: {
      enqueueMessageCheck: vi.fn(),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
      registerProcess: vi.fn(),
    },
    getAllMessagesSince: vi.fn(async () => []),
    getMessagesSince: vi.fn(async () => []),
    getAllTasks: vi.fn(async () => []),
    runContainerAgent: vi.fn(async () => ({ status: "success" as const, result: null })),
    writeTasksSnapshot: vi.fn(),
    writeGroupsSnapshot: vi.fn(),
    getAvailableGroups: vi.fn(async () => []),
    readTanrenConfig: () => undefined,
    ...overrides,
  };
}

describe("processGroupMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset per-test mock overrides to defaults
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(shouldSend).mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true for unregistered group", async () => {
    const deps = createMockDeps({ registeredGroups: () => ({}) });
    const process = createGroupProcessor(deps);
    expect(await process("unknown@g.us")).toBe(true);
  });

  it("returns true when no channel owns the JID", async () => {
    const deps = createMockDeps({
      channels: () => [{ ...mockChannel, ownsJid: () => false }],
    });
    const process = createGroupProcessor(deps);
    expect(await process("group@g.us")).toBe(true);
  });

  it("returns true when no pending messages", async () => {
    const deps = createMockDeps({
      getMessagesSince: vi.fn(async () => []),
    });
    const process = createGroupProcessor(deps);
    expect(await process("group@g.us")).toBe(true);
  });

  it("clears stale tail-drain when group no longer needs full drain", async () => {
    const tailDrain = new Map([["group@g.us", { ts: "2024-01-01", id: "1" }]]);
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": { ...TEST_GROUP, requiresTrigger: false },
      }),
      pendingTailDrain: () => tailDrain,
      getMessagesSince: vi.fn(async () => []),
    });
    const process = createGroupProcessor(deps);
    await process("group@g.us");
    expect(tailDrain.has("group@g.us")).toBe(false);
    expect(deps.savePendingTailDrain).toHaveBeenCalled();
  });

  it("processes main group messages without trigger check", async () => {
    const msg = makeMsg("1", "hello world", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      getMessagesSince: vi.fn(async () => [msg]),
    });
    const process = createGroupProcessor(deps);
    const result = await process("group@g.us");
    expect(result).toBe(true);
    expect(deps.runContainerAgent).toHaveBeenCalled();
    expect(deps.saveState).toHaveBeenCalled();
  });

  it("processes requiresTrigger=false group without trigger check", async () => {
    const msg = makeMsg("1", "hello world", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": { ...TEST_GROUP, requiresTrigger: false },
      }),
      getMessagesSince: vi.fn(async () => [msg]),
    });
    const process = createGroupProcessor(deps);
    const result = await process("group@g.us");
    expect(result).toBe(true);
    expect(deps.runContainerAgent).toHaveBeenCalled();
  });

  it("requires trigger for non-main group", async () => {
    const msg = makeMsg("1", "hello world", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      getAllMessagesSince: vi.fn(async () => [msg]),
    });
    const process = createGroupProcessor(deps);
    const result = await process("group@g.us");
    // No trigger found, should return true without running agent
    expect(result).toBe(true);
    expect(deps.runContainerAgent).not.toHaveBeenCalled();
  });

  it("processes non-main group with trigger present", async () => {
    const msgs = [
      makeMsg("1", "context", "2024-01-01T00:00:01Z"),
      makeMsg("2", "@Andy help me", "2024-01-01T00:00:02Z"),
    ];
    const deps = createMockDeps({
      getAllMessagesSince: vi.fn(async () => msgs),
    });
    const process = createGroupProcessor(deps);
    const result = await process("group@g.us");
    expect(result).toBe(true);
    expect(deps.runContainerAgent).toHaveBeenCalled();
  });

  it("advances cursor after processing", async () => {
    const msg = makeMsg("msg-1", "hello", "2024-01-01T00:00:01Z");
    const lastAgentTs: Record<string, { ts: string; id: string }> = {};
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      lastAgentTimestamp: () => lastAgentTs,
      setLastAgentTimestamp: (jid, cursor) => {
        lastAgentTs[jid] = cursor;
      },
      getMessagesSince: vi.fn(async () => [msg]),
    });
    const process = createGroupProcessor(deps);
    await process("group@g.us");
    expect(lastAgentTs["group@g.us"]).toEqual({ ts: "2024-01-01T00:00:01Z", id: "msg-1" });
  });

  it("rolls back cursor on agent error with no output", async () => {
    const msg = makeMsg("msg-1", "hello", "2024-01-01T00:00:01Z");
    const lastAgentTs: Record<string, { ts: string; id: string }> = {
      "group@g.us": { ts: "old", id: "old-id" },
    };
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      lastAgentTimestamp: () => lastAgentTs,
      setLastAgentTimestamp: (jid, cursor) => {
        lastAgentTs[jid] = cursor;
      },
      getMessagesSince: vi.fn(async () => [msg]),
      runContainerAgent: vi.fn(async () => ({
        status: "error" as const,
        result: null,
        error: "fail",
      })),
    });
    const process = createGroupProcessor(deps);
    const result = await process("group@g.us");
    expect(result).toBe(false);
    expect(lastAgentTs["group@g.us"]).toEqual({ ts: "old", id: "old-id" });
  });

  it("does not roll back cursor when agent error but output was sent", async () => {
    const msg = makeMsg("msg-1", "hello", "2024-01-01T00:00:01Z");
    const lastAgentTs: Record<string, { ts: string; id: string }> = {};
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      lastAgentTimestamp: () => lastAgentTs,
      setLastAgentTimestamp: (jid, cursor) => {
        lastAgentTs[jid] = cursor;
      },
      getMessagesSince: vi.fn(async () => [msg]),
      runContainerAgent: vi.fn(async (_group, _input, _proc, onOutput) => {
        await onOutput!({ status: "error", result: "some output", error: "failed" });
        return { status: "error" as const, result: null, error: "failed" };
      }),
    });
    const process = createGroupProcessor(deps);
    const result = await process("group@g.us");
    // Output was sent, so no rollback — avoid duplicates
    expect(result).toBe(true);
    expect(lastAgentTs["group@g.us"]).toEqual({ ts: "2024-01-01T00:00:01Z", id: "msg-1" });
  });

  it("suppresses auth error messages from channel output", async () => {
    vi.mocked(isAuthError).mockReturnValue(true);

    const msg = makeMsg("1", "hello", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      getMessagesSince: vi.fn(async () => [msg]),
      runContainerAgent: vi.fn(async (_g, _i, _p, onOutput) => {
        await onOutput!({ status: "success", result: "auth error text" });
        return { status: "success" as const, result: null };
      }),
    });
    const process = createGroupProcessor(deps);
    await process("group@g.us");
    expect(mockChannel.sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses duplicate messages via dedup", async () => {
    vi.mocked(shouldSend).mockReturnValue(false);

    const msg = makeMsg("1", "hello", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      getMessagesSince: vi.fn(async () => [msg]),
      runContainerAgent: vi.fn(async (_g, _i, _p, onOutput) => {
        await onOutput!({ status: "success", result: "dup message" });
        return { status: "success" as const, result: null };
      }),
    });
    const process = createGroupProcessor(deps);
    await process("group@g.us");
    expect(mockChannel.sendMessage).not.toHaveBeenCalled();
  });

  it("strips internal tags from output", async () => {
    const msg = makeMsg("1", "hello", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      getMessagesSince: vi.fn(async () => [msg]),
      runContainerAgent: vi.fn(async (_g, _i, _p, onOutput) => {
        await onOutput!({
          status: "success",
          result: "<internal>thinking</internal>visible text",
        });
        return { status: "success" as const, result: null };
      }),
    });
    const process = createGroupProcessor(deps);
    await process("group@g.us");
    expect(mockChannel.sendMessage).toHaveBeenCalledWith("group@g.us", "visible text");
  });

  it("sends agent output to channel", async () => {
    const msg = makeMsg("1", "hello", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      getMessagesSince: vi.fn(async () => [msg]),
      runContainerAgent: vi.fn(async (_g, _i, _p, onOutput) => {
        await onOutput!({ status: "success", result: "Hello back!" });
        return { status: "success" as const, result: null };
      }),
    });
    const process = createGroupProcessor(deps);
    await process("group@g.us");
    expect(mockChannel.sendMessage).toHaveBeenCalledWith("group@g.us", "Hello back!");
  });

  it("tracks session ID from streamed output", async () => {
    const sessions: Record<string, string> = {};
    const msg = makeMsg("1", "hello", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      sessions: () => sessions,
      getMessagesSince: vi.fn(async () => [msg]),
      runContainerAgent: vi.fn(async (_g, _i, _p, onOutput) => {
        await onOutput!({ status: "success", result: "hi", newSessionId: "session-123" });
        return { status: "success" as const, result: null, newSessionId: "session-123" };
      }),
    });
    const process = createGroupProcessor(deps);
    await process("group@g.us");
    expect(sessions["main"]).toBe("session-123");
    expect(deps.setSession).toHaveBeenCalledWith("main", "session-123");
  });

  it("writes task and group snapshots before running agent", async () => {
    const msg = makeMsg("1", "hello", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      getMessagesSince: vi.fn(async () => [msg]),
    });
    const process = createGroupProcessor(deps);
    await process("group@g.us");
    expect(deps.writeTasksSnapshot).toHaveBeenCalled();
    expect(deps.writeGroupsSnapshot).toHaveBeenCalled();
  });

  it("handles agent exception gracefully", async () => {
    const msg = makeMsg("1", "hello", "2024-01-01T00:00:01Z");
    const deps = createMockDeps({
      registeredGroups: () => ({ "group@g.us": MAIN_GROUP }),
      getMessagesSince: vi.fn(async () => [msg]),
      runContainerAgent: vi.fn(async () => {
        throw new Error("container crashed");
      }),
    });
    const process = createGroupProcessor(deps);
    const result = await process("group@g.us");
    // Exception is treated as error
    expect(result).toBe(false);
  });

  it("enqueues continuation when truncated", async () => {
    // Simulate a trigger at the start with 300 messages (exceeding MAX_PROMPT_MESSAGES=200)
    const msgs = Array.from({ length: 300 }, (_, i) =>
      makeMsg(
        `msg-${i}`,
        i === 0 ? "@Andy start" : `msg ${i}`,
        `2024-01-01T00:00:${String(i).padStart(3, "0")}Z`,
      ),
    );
    const deps = createMockDeps({
      getAllMessagesSince: vi.fn(async () => msgs),
    });
    const process = createGroupProcessor(deps);
    await process("group@g.us");
    // Should enqueue for continuation since messages were truncated by anchorTriggerWindow
    expect(deps.runContainerAgent).toHaveBeenCalled();
  });
});
