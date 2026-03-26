/**
 * Integration tests for the full IPC round-trip:
 * file write → watcher detects → Zod validates → authorization check → routes to handler → DB mutations.
 */
import fs from "fs";
import { mkdir, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IpcWatcher } from "./ipc-watcher.js";
import { processIpcFiles, type IpcDeps } from "./ipc.js";
import { _initTestDatabase, createTask, getAllTasks, getTaskById } from "./db.js";

let mockDataDir = "";

vi.mock("./config.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    get DATA_DIR() {
      return mockDataDir;
    },
    IPC_DEBOUNCE_MS: 50,
    IPC_FALLBACK_POLL_INTERVAL: 200,
    TIMEZONE: "UTC",
  };
});

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

let tmpDir: string;
let ipcBaseDir: string;

function createDeps(overrides?: Partial<IpcDeps>): IpcDeps {
  return {
    sendMessage: vi.fn(async () => {}),
    registeredGroups: () => ({
      "group@test": {
        name: "Test",
        folder: "test-group",
        trigger: "@Andy",
        added_at: "2024-01-01",
      },
      "main@test": {
        name: "Main",
        folder: "main-group",
        trigger: "@Andy",
        added_at: "2024-01-01",
        isMain: true,
      },
    }),
    registerGroup: vi.fn(async () => {}),
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(async () => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(async () => {}),
    ...overrides,
  };
}

async function writeIpcMessage(
  groupFolder: string,
  filename: string,
  data: unknown,
): Promise<void> {
  const dir = path.join(ipcBaseDir, groupFolder, "messages");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), JSON.stringify(data));
}

async function writeIpcTask(groupFolder: string, filename: string, data: unknown): Promise<void> {
  const dir = path.join(ipcBaseDir, groupFolder, "tasks");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), JSON.stringify(data));
}

describe("IPC processing integration", () => {
  beforeEach(async () => {
    await _initTestDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-integration-"));
    ipcBaseDir = path.join(tmpDir, "ipc");
    await mkdir(ipcBaseDir, { recursive: true });
    mockDataDir = tmpDir;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("message file validated, authorized, delivered, and deleted", async () => {
    await writeIpcMessage("main-group", "msg1.json", {
      type: "message",
      chatJid: "main@test",
      text: "Hello",
    });

    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);

    expect(deps.sendMessage).toHaveBeenCalledWith("main@test", "Hello");
    expect(fs.existsSync(path.join(ipcBaseDir, "main-group", "messages", "msg1.json"))).toBe(false);
  });

  it("malformed JSON moved to errors/", async () => {
    const msgDir = path.join(ipcBaseDir, "main-group", "messages");
    await mkdir(msgDir, { recursive: true });
    await writeFile(path.join(msgDir, "bad.json"), "not valid json{{");

    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);

    expect(fs.existsSync(path.join(msgDir, "bad.json"))).toBe(false);
    expect(fs.existsSync(path.join(ipcBaseDir, "errors", "main-group-bad.json"))).toBe(true);
  });

  it("Zod schema rejection moves to errors/", async () => {
    await writeIpcMessage("main-group", "invalid.json", {
      type: "message",
      // missing chatJid and text — required by IpcMessageSchema
    });

    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);

    expect(fs.existsSync(path.join(ipcBaseDir, "errors", "main-group-invalid.json"))).toBe(true);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("non-main group blocked from cross-group send", async () => {
    await writeIpcMessage("test-group", "msg1.json", {
      type: "message",
      chatJid: "main@test",
      text: "hack",
    });

    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    // File still gets deleted (processed but unauthorized)
    expect(fs.existsSync(path.join(ipcBaseDir, "test-group", "messages", "msg1.json"))).toBe(false);
  });

  it("main group can send cross-group", async () => {
    await writeIpcMessage("main-group", "msg1.json", {
      type: "message",
      chatJid: "group@test",
      text: "cross-group",
    });

    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);

    expect(deps.sendMessage).toHaveBeenCalledWith("group@test", "cross-group");
  });

  it("schedule_task creates task in DB with correct next_run", async () => {
    await writeIpcTask("main-group", "task1.json", {
      type: "schedule_task",
      targetJid: "main@test",
      prompt: "daily check",
      schedule_type: "interval",
      schedule_value: "60000",
    });

    const deps = createDeps();
    const beforeTime = Date.now();
    await processIpcFiles(ipcBaseDir, deps);

    expect(deps.onTasksChanged).toHaveBeenCalled();

    const tasks = await getAllTasks();
    expect(tasks.length).toBe(1);

    const task = tasks[0];
    expect(task.prompt).toBe("daily check");
    expect(task.schedule_type).toBe("interval");
    expect(task.schedule_value).toBe("60000");
    expect(task.group_folder).toBe("main-group");
    expect(task.chat_jid).toBe("main@test");
    expect(task.status).toBe("active");

    // next_run should be ~60s from now
    const nextRun = new Date(task.next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(beforeTime + 60000 - 100);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 60000 + 100);
  });

  it("pause_task updates task status", async () => {
    await createTask({
      id: "test-task-1",
      group_folder: "main-group",
      chat_jid: "main@test",
      prompt: "check something",
      schedule_type: "interval",
      schedule_value: "60000",
      context_mode: "isolated",
      next_run: new Date(Date.now() + 60000).toISOString(),
      status: "active",
      created_at: new Date().toISOString(),
    });

    await writeIpcTask("main-group", "pause.json", {
      type: "pause_task",
      taskId: "test-task-1",
    });

    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);

    const task = await getTaskById("test-task-1");
    expect(task).toBeDefined();
    expect(task!.status).toBe("paused");
  });

  it("cancel_task deletes task from DB", async () => {
    await createTask({
      id: "test-task-2",
      group_folder: "main-group",
      chat_jid: "main@test",
      prompt: "check something",
      schedule_type: "interval",
      schedule_value: "60000",
      context_mode: "isolated",
      next_run: new Date(Date.now() + 60000).toISOString(),
      status: "active",
      created_at: new Date().toISOString(),
    });

    await writeIpcTask("main-group", "cancel.json", {
      type: "cancel_task",
      taskId: "test-task-2",
    });

    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);

    const task = await getTaskById("test-task-2");
    expect(task).toBeUndefined();
  });
});

describe("IPC watcher integration", () => {
  beforeEach(async () => {
    await _initTestDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-watcher-integration-"));
    ipcBaseDir = path.join(tmpDir, "ipc");
    await mkdir(ipcBaseDir, { recursive: true });
    mockDataDir = tmpDir;
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("watcher detects file via fs.watch and processes it", async () => {
    const deps = createDeps();
    const watcher = new IpcWatcher(deps);

    try {
      await watcher.start();
      // Wait for watcher to initialize
      await new Promise((r) => setTimeout(r, 100));

      await writeIpcMessage("main-group", "live.json", {
        type: "message",
        chatJid: "main@test",
        text: "detected by watcher",
      });

      // Wait for debounce (50ms) + processing
      await new Promise((r) => setTimeout(r, 500));

      expect(deps.sendMessage).toHaveBeenCalledWith("main@test", "detected by watcher");
    } finally {
      watcher.stop();
    }
  });

  it("register_group from main creates group; blocked from non-main", async () => {
    const deps = createDeps();

    // Main group registers a new group — should be allowed
    await writeIpcTask("main-group", "reg.json", {
      type: "register_group",
      jid: "new@test",
      name: "New Group",
      folder: "new-group",
      trigger: "@Andy",
    });
    await processIpcFiles(ipcBaseDir, deps);

    expect(deps.registerGroup).toHaveBeenCalledTimes(1);
    expect(deps.registerGroup).toHaveBeenCalledWith(
      "new@test",
      expect.objectContaining({
        name: "New Group",
        folder: "new-group",
        trigger: "@Andy",
      }),
    );

    // Non-main group tries to register — should be blocked
    await writeIpcTask("test-group", "reg2.json", {
      type: "register_group",
      jid: "sneaky@test",
      name: "Sneaky Group",
      folder: "sneaky-group",
      trigger: "@Andy",
    });
    await processIpcFiles(ipcBaseDir, deps);

    // registerGroup should still only have been called once (the main-group call)
    expect(deps.registerGroup).toHaveBeenCalledTimes(1);
  });
});
