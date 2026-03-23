import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { processIpcFiles } from "./ipc.js";
import { _initTestDatabase } from "./db.js";
import type { IpcDeps } from "./ipc.js";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const TEST_GROUP = {
  name: "Test",
  folder: "test-group",
  trigger: "@Andy",
  added_at: "2024-01-01",
};

const MAIN_GROUP = {
  ...TEST_GROUP,
  name: "Main",
  folder: "main-group",
  isMain: true,
};

let ipcBaseDir: string;

function createDeps(overrides?: Partial<IpcDeps>): IpcDeps {
  return {
    sendMessage: vi.fn(async () => {}),
    registeredGroups: () => ({
      "group@g.us": { ...TEST_GROUP },
      "main@g.us": { ...MAIN_GROUP },
    }),
    registerGroup: vi.fn(async () => {}),
    syncGroups: vi.fn(async () => {}),
    getAvailableGroups: vi.fn(async () => []),
    writeGroupsSnapshot: vi.fn(),
    ...overrides,
  };
}

function writeIpcFile(groupFolder: string, subdir: string, filename: string, data: unknown): void {
  const dir = path.join(ipcBaseDir, groupFolder, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data));
}

describe("processIpcFiles", () => {
  beforeEach(async () => {
    await _initTestDatabase();
    vi.clearAllMocks();
    ipcBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-test-"));
  });

  afterEach(() => {
    fs.rmSync(ipcBaseDir, { recursive: true, force: true });
  });

  it("does nothing with empty IPC directory", async () => {
    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("sends authorized message and deletes file", async () => {
    writeIpcFile("test-group", "messages", "msg1.json", {
      type: "message",
      chatJid: "group@g.us",
      text: "Hello from IPC",
    });
    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);
    expect(deps.sendMessage).toHaveBeenCalledWith("group@g.us", "Hello from IPC");
    // File should be deleted after processing
    expect(fs.existsSync(path.join(ipcBaseDir, "test-group", "messages", "msg1.json"))).toBe(false);
  });

  it("main group can send to any JID", async () => {
    writeIpcFile("main-group", "messages", "msg1.json", {
      type: "message",
      chatJid: "group@g.us",
      text: "Cross-group message",
    });
    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);
    expect(deps.sendMessage).toHaveBeenCalledWith("group@g.us", "Cross-group message");
  });

  it("blocks unauthorized message from non-main group", async () => {
    writeIpcFile("test-group", "messages", "msg1.json", {
      type: "message",
      chatJid: "main@g.us", // trying to send to a different group
      text: "Sneaky message",
    });
    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("moves invalid JSON to errors directory", async () => {
    const dir = path.join(ipcBaseDir, "test-group", "messages");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bad.json"), "not valid json{{{");
    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);
    // File should be moved to errors/
    expect(fs.existsSync(path.join(ipcBaseDir, "errors", "test-group-bad.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "bad.json"))).toBe(false);
  });

  it("moves schema validation failure to errors directory", async () => {
    writeIpcFile("test-group", "messages", "invalid.json", {
      type: "message",
      chatJid: "group@g.us",
      // text is missing — required by schema
    });
    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);
    expect(fs.existsSync(path.join(ipcBaseDir, "errors", "test-group-invalid.json"))).toBe(true);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("skips errors subdirectory", async () => {
    // Create an "errors" directory that looks like a group folder
    fs.mkdirSync(path.join(ipcBaseDir, "errors", "messages"), { recursive: true });
    fs.writeFileSync(
      path.join(ipcBaseDir, "errors", "messages", "old.json"),
      JSON.stringify({ type: "message", chatJid: "x", text: "old" }),
    );
    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("ignores non-JSON files", async () => {
    const dir = path.join(ipcBaseDir, "test-group", "messages");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a json file");
    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);
    expect(deps.sendMessage).not.toHaveBeenCalled();
    // txt file should remain untouched
    expect(fs.existsSync(path.join(dir, "readme.txt"))).toBe(true);
  });

  it("processes task files via processTaskIpc", async () => {
    writeIpcFile("main-group", "tasks", "task1.json", {
      type: "schedule_task",
      targetJid: "group@g.us",
      prompt: "scheduled task",
      schedule_type: "once",
      schedule_value: new Date(Date.now() + 60000).toISOString(),
    });
    const deps = createDeps();
    await processIpcFiles(ipcBaseDir, deps);
    // File should be deleted after successful processing
    expect(fs.existsSync(path.join(ipcBaseDir, "main-group", "tasks", "task1.json"))).toBe(false);
  });
});
