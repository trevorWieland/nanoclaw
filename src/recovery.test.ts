import { beforeEach, describe, expect, it, vi } from "vitest";

import { recoverPendingMessages } from "./recovery.js";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

function createMockDeps(
  overrides?: Partial<Parameters<typeof recoverPendingMessages>[0]>,
): Parameters<typeof recoverPendingMessages>[0] {
  return {
    registeredGroups: () => ({}),
    lastAgentTimestamp: () => ({}),
    pendingTailDrain: () => new Map(),
    queue: { enqueueMessageCheck: vi.fn() },
    savePendingTailDrain: vi.fn(),
    getMessagesSince: vi.fn(async () => []),
    ASSISTANT_NAME: "Andy",
    ...overrides,
  };
}

describe("recoverPendingMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no pending state exists", async () => {
    const deps = createMockDeps();
    await recoverPendingMessages(deps);
    expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(deps.savePendingTailDrain).not.toHaveBeenCalled();
  });

  it("enqueues groups with pending tail-drain entries", async () => {
    const tailDrain = new Map([["group@g.us", { ts: "2024-01-01", id: "1" }]]);
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": { name: "Test", folder: "test", trigger: "@Andy", added_at: "" },
      }),
      pendingTailDrain: () => tailDrain,
    });
    await recoverPendingMessages(deps);
    expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith("group@g.us");
  });

  it("deletes pending tail-drain for unregistered groups", async () => {
    const tailDrain = new Map([["gone@g.us", { ts: "2024-01-01", id: "1" }]]);
    const deps = createMockDeps({
      pendingTailDrain: () => tailDrain,
    });
    await recoverPendingMessages(deps);
    expect(tailDrain.has("gone@g.us")).toBe(false);
    expect(deps.savePendingTailDrain).toHaveBeenCalled();
  });

  it("enqueues groups with pending messages at cursor", async () => {
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": { name: "Test", folder: "test", trigger: "@Andy", added_at: "" },
      }),
      getMessagesSince: vi.fn(async () => [{ timestamp: "2024-01-01", id: "msg1" }]),
    });
    await recoverPendingMessages(deps);
    expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith("group@g.us");
  });

  it("does not enqueue groups with no pending messages", async () => {
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": { name: "Test", folder: "test", trigger: "@Andy", added_at: "" },
      }),
      getMessagesSince: vi.fn(async () => []),
    });
    await recoverPendingMessages(deps);
    expect(deps.queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it("skips Phase 2 for groups already enqueued in Phase 1", async () => {
    const tailDrain = new Map([["group@g.us", { ts: "2024-01-01", id: "1" }]]);
    const deps = createMockDeps({
      registeredGroups: () => ({
        "group@g.us": { name: "Test", folder: "test", trigger: "@Andy", added_at: "" },
      }),
      pendingTailDrain: () => tailDrain,
      getMessagesSince: vi.fn(async () => [{ timestamp: "2024-01-02", id: "msg2" }]),
    });
    await recoverPendingMessages(deps);
    // Should only be called once (Phase 1), not twice
    expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledTimes(1);
  });

  it("handles mixed tail-drain and pending-messages groups", async () => {
    const tailDrain = new Map([["drain@g.us", { ts: "2024-01-01", id: "1" }]]);
    const deps = createMockDeps({
      registeredGroups: () => ({
        "drain@g.us": { name: "Drain", folder: "drain", trigger: "@Andy", added_at: "" },
        "pending@g.us": { name: "Pending", folder: "pending", trigger: "@Andy", added_at: "" },
      }),
      pendingTailDrain: () => tailDrain,
      getMessagesSince: vi.fn(async () => [{ timestamp: "2024-01-02", id: "msg2" }]),
    });
    await recoverPendingMessages(deps);
    expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith("drain@g.us");
    expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith("pending@g.us");
    expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledTimes(2);
  });
});
