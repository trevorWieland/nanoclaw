import { describe, it, expect } from "vitest";

import {
  ContainerInputSchema,
  ContainerOutputSchema,
  FollowUpMessageSchema,
  GroupsSnapshotSchema,
  IpcMessageSchema,
  TaskIpcSchema,
  TaskSnapshotSchema,
} from "./ipc-schemas.js";

// =========================================
// IpcMessageSchema (container → host)
// =========================================

describe("IpcMessageSchema", () => {
  it("accepts valid minimal message", () => {
    const result = IpcMessageSchema.safeParse({
      type: "message",
      chatJid: "group@g.us",
      text: "hello",
    });
    expect(result.success).toBe(true);
  });

  it("accepts message with optional sender", () => {
    const result = IpcMessageSchema.safeParse({
      type: "message",
      chatJid: "group@g.us",
      text: "hello",
      sender: "Researcher",
    });
    expect(result.success).toBe(true);
  });

  it("accepts extra passthrough fields from container", () => {
    const result = IpcMessageSchema.safeParse({
      type: "message",
      chatJid: "group@g.us",
      text: "hello",
      timestamp: "2026-01-01T00:00:00Z",
      groupFolder: "test-group",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing chatJid", () => {
    const result = IpcMessageSchema.safeParse({
      type: "message",
      text: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing text", () => {
    const result = IpcMessageSchema.safeParse({
      type: "message",
      chatJid: "group@g.us",
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong type literal", () => {
    const result = IpcMessageSchema.safeParse({
      type: "not_message",
      chatJid: "group@g.us",
      text: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing type field", () => {
    const result = IpcMessageSchema.safeParse({
      chatJid: "group@g.us",
      text: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty chatJid", () => {
    const result = IpcMessageSchema.safeParse({
      type: "message",
      chatJid: "",
      text: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = IpcMessageSchema.safeParse({
      type: "message",
      chatJid: "group@g.us",
      text: "",
    });
    expect(result.success).toBe(false);
  });
});

// =========================================
// TaskIpcSchema discriminated union
// =========================================

describe("TaskIpcSchema", () => {
  it("accepts valid schedule_task", () => {
    const result = TaskIpcSchema.safeParse({
      type: "schedule_task",
      prompt: "do something",
      schedule_type: "cron",
      schedule_value: "0 9 * * *",
      targetJid: "group@g.us",
    });
    expect(result.success).toBe(true);
  });

  it("accepts schedule_task with optional fields", () => {
    const result = TaskIpcSchema.safeParse({
      type: "schedule_task",
      taskId: "task-123",
      prompt: "do something",
      schedule_type: "once",
      schedule_value: "2026-01-01T00:00:00",
      context_mode: "group",
      targetJid: "group@g.us",
      timestamp: "2026-01-01T00:00:00Z",
      createdBy: "test-group",
    });
    expect(result.success).toBe(true);
  });

  it("rejects schedule_task missing prompt", () => {
    const result = TaskIpcSchema.safeParse({
      type: "schedule_task",
      schedule_type: "once",
      schedule_value: "2026-01-01T00:00:00",
      targetJid: "group@g.us",
    });
    expect(result.success).toBe(false);
  });

  it("rejects schedule_task missing targetJid", () => {
    const result = TaskIpcSchema.safeParse({
      type: "schedule_task",
      prompt: "do something",
      schedule_type: "once",
      schedule_value: "2026-01-01T00:00:00",
    });
    expect(result.success).toBe(false);
  });

  it("rejects schedule_task with invalid schedule_type", () => {
    const result = TaskIpcSchema.safeParse({
      type: "schedule_task",
      prompt: "do something",
      schedule_type: "weekly",
      schedule_value: "MON",
      targetJid: "group@g.us",
    });
    expect(result.success).toBe(false);
  });

  it("rejects schedule_task with empty prompt", () => {
    const result = TaskIpcSchema.safeParse({
      type: "schedule_task",
      prompt: "",
      schedule_type: "once",
      schedule_value: "2026-01-01T00:00:00",
      targetJid: "group@g.us",
    });
    expect(result.success).toBe(false);
  });

  it("rejects schedule_task with empty targetJid", () => {
    const result = TaskIpcSchema.safeParse({
      type: "schedule_task",
      prompt: "do something",
      schedule_type: "once",
      schedule_value: "2026-01-01T00:00:00",
      targetJid: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects pause_task with empty taskId", () => {
    const result = TaskIpcSchema.safeParse({
      type: "pause_task",
      taskId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects register_group with empty jid", () => {
    const result = TaskIpcSchema.safeParse({
      type: "register_group",
      jid: "",
      name: "Test",
      folder: "test-group",
      trigger: "@Bot",
    });
    expect(result.success).toBe(false);
  });

  it("rejects register_group with empty trigger", () => {
    const result = TaskIpcSchema.safeParse({
      type: "register_group",
      jid: "group@g.us",
      name: "Test",
      folder: "test-group",
      trigger: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects schedule_task with invalid context_mode", () => {
    const result = TaskIpcSchema.safeParse({
      type: "schedule_task",
      prompt: "do something",
      schedule_type: "once",
      schedule_value: "2026-01-01T00:00:00",
      context_mode: "bogus",
      targetJid: "group@g.us",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid pause_task", () => {
    const result = TaskIpcSchema.safeParse({
      type: "pause_task",
      taskId: "task-123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects pause_task missing taskId", () => {
    const result = TaskIpcSchema.safeParse({
      type: "pause_task",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid resume_task", () => {
    const result = TaskIpcSchema.safeParse({
      type: "resume_task",
      taskId: "task-123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects resume_task missing taskId", () => {
    const result = TaskIpcSchema.safeParse({
      type: "resume_task",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid cancel_task", () => {
    const result = TaskIpcSchema.safeParse({
      type: "cancel_task",
      taskId: "task-123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects cancel_task missing taskId", () => {
    const result = TaskIpcSchema.safeParse({
      type: "cancel_task",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid update_task with only taskId", () => {
    const result = TaskIpcSchema.safeParse({
      type: "update_task",
      taskId: "task-123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts update_task with optional fields", () => {
    const result = TaskIpcSchema.safeParse({
      type: "update_task",
      taskId: "task-123",
      prompt: "new prompt",
      schedule_type: "interval",
      schedule_value: "3600000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects update_task missing taskId", () => {
    const result = TaskIpcSchema.safeParse({
      type: "update_task",
      prompt: "orphaned update",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid register_group", () => {
    const result = TaskIpcSchema.safeParse({
      type: "register_group",
      jid: "new@g.us",
      name: "New Group",
      folder: "new-group",
      trigger: "@Andy",
    });
    expect(result.success).toBe(true);
  });

  it("accepts register_group with containerConfig", () => {
    const result = TaskIpcSchema.safeParse({
      type: "register_group",
      jid: "new@g.us",
      name: "New Group",
      folder: "new-group",
      trigger: "@Andy",
      requiresTrigger: false,
      containerConfig: {
        timeout: 600000,
        memoryLimit: "4g",
        cpuLimit: "2",
        additionalMounts: [{ hostPath: "/tmp/data", readonly: true }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects register_group missing required fields", () => {
    const result = TaskIpcSchema.safeParse({
      type: "register_group",
      jid: "partial@g.us",
      name: "Partial",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid refresh_groups", () => {
    const result = TaskIpcSchema.safeParse({
      type: "refresh_groups",
    });
    expect(result.success).toBe(true);
  });

  it("accepts refresh_groups with passthrough fields", () => {
    const result = TaskIpcSchema.safeParse({
      type: "refresh_groups",
      timestamp: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown type value", () => {
    const result = TaskIpcSchema.safeParse({
      type: "unknown_action",
      taskId: "task-123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing type field", () => {
    const result = TaskIpcSchema.safeParse({
      taskId: "task-123",
    });
    expect(result.success).toBe(false);
  });
});

// =========================================
// ContainerOutputSchema (container → host)
// =========================================

describe("ContainerOutputSchema", () => {
  it("accepts valid success output", () => {
    const result = ContainerOutputSchema.safeParse({
      status: "success",
      result: "Here is the response",
      newSessionId: "session-abc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid error output", () => {
    const result = ContainerOutputSchema.safeParse({
      status: "error",
      result: null,
      error: "Something went wrong",
    });
    expect(result.success).toBe(true);
  });

  it("accepts null result", () => {
    const result = ContainerOutputSchema.safeParse({
      status: "success",
      result: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts passthrough extras from container", () => {
    const result = ContainerOutputSchema.safeParse({
      status: "success",
      result: "ok",
      extraField: "ignored",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid status enum", () => {
    const result = ContainerOutputSchema.safeParse({
      status: "pending",
      result: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing result field", () => {
    const result = ContainerOutputSchema.safeParse({
      status: "success",
    });
    expect(result.success).toBe(false);
  });
});

// =========================================
// ContainerInputSchema (host → container)
// =========================================

describe("ContainerInputSchema", () => {
  it("accepts valid minimal input", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid full input", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      sessionId: "session-123",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: true,
      isScheduledTask: true,
      assistantName: "Andy",
      tanren: { apiUrl: "http://localhost:3000", apiKey: "key-123" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: false,
      unexpectedField: "oops",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing prompt", () => {
    const result = ContainerInputSchema.safeParse({
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong isMain type", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: "true",
    });
    expect(result.success).toBe(false);
  });

  it("rejects partial tanren (missing apiKey)", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: false,
      tanren: { apiUrl: "http://localhost:3000" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts input with mcpServers (http)", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: true,
      mcpServers: {
        vectordb: { type: "http", url: "http://example.com/mcp" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts input with mcpServers (sse with headers)", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: true,
      mcpServers: {
        myserver: {
          type: "sse",
          url: "http://example.com/sse",
          headers: { Authorization: "Bearer token123" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts input without mcpServers (backward compatible)", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects mcpServers with invalid type", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: true,
      mcpServers: {
        bad: { type: "websocket", url: "ws://example.com" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts mcpServers with multiple servers", () => {
    const result = ContainerInputSchema.safeParse({
      prompt: "hello",
      groupFolder: "test-group",
      chatJid: "group@g.us",
      isMain: true,
      mcpServers: {
        server1: { type: "http", url: "http://a.com/mcp" },
        server2: { type: "sse", url: "http://b.com/sse" },
      },
    });
    expect(result.success).toBe(true);
  });
});

// =========================================
// FollowUpMessageSchema (host → container)
// =========================================

describe("FollowUpMessageSchema", () => {
  it("accepts valid message", () => {
    const result = FollowUpMessageSchema.safeParse({
      type: "message",
      text: "follow up text",
    });
    expect(result.success).toBe(true);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = FollowUpMessageSchema.safeParse({
      type: "message",
      text: "hello",
      extra: "not allowed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing text", () => {
    const result = FollowUpMessageSchema.safeParse({
      type: "message",
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong type literal", () => {
    const result = FollowUpMessageSchema.safeParse({
      type: "task",
      text: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty text", () => {
    const result = FollowUpMessageSchema.safeParse({
      type: "message",
      text: "",
    });
    expect(result.success).toBe(false);
  });
});

// =========================================
// TaskSnapshotSchema (host → container)
// =========================================

describe("TaskSnapshotSchema", () => {
  it("accepts valid task array", () => {
    const result = TaskSnapshotSchema.safeParse([
      {
        id: "task-1",
        groupFolder: "test-group",
        prompt: "do something",
        schedule_type: "cron",
        schedule_value: "0 9 * * *",
        status: "active",
        next_run: "2026-01-01T09:00:00.000Z",
      },
    ]);
    expect(result.success).toBe(true);
  });

  it("accepts empty array", () => {
    const result = TaskSnapshotSchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("accepts entry with null next_run", () => {
    const result = TaskSnapshotSchema.safeParse([
      {
        id: "task-1",
        groupFolder: "test-group",
        prompt: "one-time task",
        schedule_type: "once",
        schedule_value: "2026-01-01T00:00:00",
        status: "completed",
        next_run: null,
      },
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects entry missing required field", () => {
    const result = TaskSnapshotSchema.safeParse([
      {
        id: "task-1",
        groupFolder: "test-group",
        // missing prompt
        schedule_type: "cron",
        schedule_value: "0 9 * * *",
        status: "active",
        next_run: null,
      },
    ]);
    expect(result.success).toBe(false);
  });
});

// =========================================
// GroupsSnapshotSchema (host → container)
// =========================================

describe("GroupsSnapshotSchema", () => {
  it("accepts valid snapshot", () => {
    const result = GroupsSnapshotSchema.safeParse({
      groups: [
        {
          jid: "group@g.us",
          name: "Test Group",
          lastActivity: "2026-01-01T00:00:00Z",
          isRegistered: true,
        },
      ],
      lastSync: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty groups array", () => {
    const result = GroupsSnapshotSchema.safeParse({
      groups: [],
      lastSync: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects extra top-level fields (strict mode)", () => {
    const result = GroupsSnapshotSchema.safeParse({
      groups: [],
      lastSync: "2026-01-01T00:00:00Z",
      extra: "not allowed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects group entry missing isRegistered", () => {
    const result = GroupsSnapshotSchema.safeParse({
      groups: [
        {
          jid: "group@g.us",
          name: "Test",
          lastActivity: "2026-01-01T00:00:00Z",
        },
      ],
      lastSync: "2026-01-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing lastSync", () => {
    const result = GroupsSnapshotSchema.safeParse({
      groups: [],
    });
    expect(result.success).toBe(false);
  });
});
