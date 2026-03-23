import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock("./config.js", () => ({
  ASSISTANT_NAME: "Andy",
  INSTANCE_ID: "test-instance",
  MAX_PROMPT_MESSAGES: 200,
  POLL_INTERVAL: 1000,
  TIMEZONE: "UTC",
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock("./sender-allowlist.js", () => ({
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: "*", mode: "trigger" },
    chats: {},
    logDenied: false,
  })),
  isTriggerAllowed: vi.fn(() => true),
}));

// Must import after mocks
const { startMessageLoop, _resetMessageLoopForTests } = await import("./message-loop.js");

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
  overrides?: Partial<Parameters<typeof startMessageLoop>[0]>,
): Parameters<typeof startMessageLoop>[0] {
  const lastAgentTs: Record<string, { ts: string; id: string }> = {};
  return {
    registeredGroups: () => ({}),
    channels: () => [mockChannel],
    lastAgentTimestamp: () => lastAgentTs,
    setLastAgentTimestamp: (jid, cursor) => {
      lastAgentTs[jid] = cursor;
    },
    pendingTailDrain: () => new Map(),
    lastTimestamp: () => "",
    setLastTimestamp: vi.fn(),
    saveState: vi.fn(),
    queue: {
      sendMessage: vi.fn(() => false),
      enqueueMessageCheck: vi.fn(),
    },
    getNewMessages: vi.fn(async () => ({ messages: [], newTimestamp: "" })),
    getMessagesSince: vi.fn(async () => []),
    ...overrides,
  };
}

describe("startMessageLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetMessageLoopForTests();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not start twice", async () => {
    const deps = createMockDeps();
    // Start and let one iteration run
    const p1 = startMessageLoop(deps);
    const p2 = startMessageLoop(deps);
    await vi.advanceTimersByTimeAsync(10);
    // getNewMessages should only be called from the first loop
    expect(deps.getNewMessages).toHaveBeenCalledTimes(1);
    // Clean up to prevent unhandled rejection
    void p1;
    void p2;
  });

  it("does nothing when no new messages", async () => {
    const deps = createMockDeps();
    void startMessageLoop(deps);
    await vi.advanceTimersByTimeAsync(10);
    expect(deps.getNewMessages).toHaveBeenCalled();
    expect(deps.saveState).not.toHaveBeenCalled();
  });

  it("enqueues message check for trigger message in non-main group", async () => {
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": {
          name: "Test",
          folder: "test",
          trigger: "@Andy",
          added_at: "",
        },
      }),
      getNewMessages: vi.fn(async () => ({
        messages: [
          {
            id: "1",
            chat_jid: "group@g.us",
            sender: "user1",
            sender_name: "User",
            content: "@Andy help",
            timestamp: "2024-01-01T00:00:01Z",
            is_from_me: false,
          },
        ],
        newTimestamp: "2024-01-01T00:00:01Z",
      })),
      getMessagesSince: vi.fn(async () => [
        {
          id: "1",
          chat_jid: "group@g.us",
          sender: "user1",
          sender_name: "User",
          content: "@Andy help",
          timestamp: "2024-01-01T00:00:01Z",
          is_from_me: false,
        },
      ]),
    });
    void startMessageLoop(deps);
    await vi.advanceTimersByTimeAsync(10);
    expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith("group@g.us");
  });

  it("skips non-main group without trigger", async () => {
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": {
          name: "Test",
          folder: "test",
          trigger: "@Andy",
          added_at: "",
        },
      }),
      getNewMessages: vi.fn(async () => ({
        messages: [
          {
            id: "1",
            chat_jid: "group@g.us",
            sender: "user1",
            sender_name: "User",
            content: "just chatting",
            timestamp: "2024-01-01T00:00:01Z",
            is_from_me: false,
          },
        ],
        newTimestamp: "2024-01-01T00:00:01Z",
      })),
    });
    void startMessageLoop(deps);
    await vi.advanceTimersByTimeAsync(10);
    expect(deps.queue.sendMessage).not.toHaveBeenCalled();
    expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it("pipes messages to active container when queue.sendMessage returns true", async () => {
    const lastAgentTs: Record<string, { ts: string; id: string }> = {};
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": {
          name: "Main",
          folder: "main",
          trigger: "@Andy",
          added_at: "",
          isMain: true,
        },
      }),
      lastAgentTimestamp: () => lastAgentTs,
      setLastAgentTimestamp: (jid, cursor) => {
        lastAgentTs[jid] = cursor;
      },
      getNewMessages: vi.fn(async () => ({
        messages: [
          {
            id: "1",
            chat_jid: "group@g.us",
            sender: "user1",
            sender_name: "User",
            content: "hello",
            timestamp: "2024-01-01T00:00:01Z",
          },
        ],
        newTimestamp: "2024-01-01T00:00:01Z",
      })),
      getMessagesSince: vi.fn(async () => [
        {
          id: "1",
          chat_jid: "group@g.us",
          sender: "user1",
          sender_name: "User",
          content: "hello",
          timestamp: "2024-01-01T00:00:01Z",
        },
      ]),
      queue: {
        sendMessage: vi.fn(() => true),
        enqueueMessageCheck: vi.fn(),
      },
    });
    void startMessageLoop(deps);
    await vi.advanceTimersByTimeAsync(10);
    expect(deps.queue.sendMessage).toHaveBeenCalled();
    expect(lastAgentTs["group@g.us"]).toEqual({ ts: "2024-01-01T00:00:01Z", id: "1" });
  });

  it("skips group with pending tail drain", async () => {
    const tailDrain = new Map([["group@g.us", { ts: "2024-01-01", id: "1" }]]);
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": {
          name: "Main",
          folder: "main",
          trigger: "@Andy",
          added_at: "",
          isMain: true,
        },
      }),
      pendingTailDrain: () => tailDrain,
      getNewMessages: vi.fn(async () => ({
        messages: [
          {
            id: "1",
            chat_jid: "group@g.us",
            sender: "user1",
            sender_name: "User",
            content: "hello",
            timestamp: "2024-01-01T00:00:01Z",
          },
        ],
        newTimestamp: "2024-01-01T00:00:01Z",
      })),
    });
    void startMessageLoop(deps);
    await vi.advanceTimersByTimeAsync(10);
    expect(deps.queue.sendMessage).not.toHaveBeenCalled();
    expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it("continues loop after error", async () => {
    let callCount = 0;
    const deps = createMockDeps({
      getNewMessages: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("transient error");
        return { messages: [], newTimestamp: "" };
      }),
    });
    void startMessageLoop(deps);
    // First iteration: error
    await vi.advanceTimersByTimeAsync(10);
    // Second iteration after POLL_INTERVAL: should work
    await vi.advanceTimersByTimeAsync(1100);
    expect(callCount).toBe(2);
  });
});
