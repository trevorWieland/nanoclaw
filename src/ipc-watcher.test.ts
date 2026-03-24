import fs from "fs";
import { mkdir, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IpcDeps } from "./ipc.js";

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
      "group@g.us": {
        name: "Test",
        folder: "test-group",
        trigger: "@Andy",
        added_at: "2024-01-01",
      },
      "main@g.us": {
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

describe("IpcWatcher", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipc-watcher-test-"));
    ipcBaseDir = path.join(tmpDir, "ipc");
    mockDataDir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("start() processes existing files on initial scan", async () => {
    await mkdir(ipcBaseDir, { recursive: true });
    await writeIpcMessage("test-group", "msg1.json", {
      type: "message",
      chatJid: "group@g.us",
      text: "pre-existing message",
    });

    const deps = createDeps();
    const { IpcWatcher } = await import("./ipc-watcher.js");
    const watcher = new IpcWatcher(deps);

    try {
      await watcher.start();
      await new Promise((r) => setTimeout(r, 300));
      expect(deps.sendMessage).toHaveBeenCalledWith("group@g.us", "pre-existing message");
    } finally {
      watcher.stop();
    }
  });

  it("stop() prevents further processing", async () => {
    const deps = createDeps();
    const { IpcWatcher } = await import("./ipc-watcher.js");
    const watcher = new IpcWatcher(deps);

    await watcher.start();
    watcher.stop();

    await mkdir(ipcBaseDir, { recursive: true });
    await writeIpcMessage("test-group", "msg1.json", {
      type: "message",
      chatJid: "group@g.us",
      text: "should not be processed",
    });

    await new Promise((r) => setTimeout(r, 400));
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it("debounces rapid file events into fewer process calls", async () => {
    const deps = createDeps();
    const { IpcWatcher } = await import("./ipc-watcher.js");
    const watcher = new IpcWatcher(deps);

    try {
      await watcher.start();
      await new Promise((r) => setTimeout(r, 300));
      vi.mocked(deps.sendMessage).mockClear();

      for (let i = 0; i < 5; i++) {
        await writeIpcMessage("test-group", `msg${i}.json`, {
          type: "message",
          chatJid: "group@g.us",
          text: `message ${i}`,
        });
      }

      await new Promise((r) => setTimeout(r, 400));
      expect(deps.sendMessage).toHaveBeenCalledTimes(5);
    } finally {
      watcher.stop();
    }
  });

  it("duplicate start() is a no-op", async () => {
    const deps = createDeps();
    const { IpcWatcher } = await import("./ipc-watcher.js");
    const watcher = new IpcWatcher(deps);

    try {
      await watcher.start();
      await watcher.start();
    } finally {
      watcher.stop();
    }
  });

  it("responds to new files via fs.watch", async () => {
    const deps = createDeps();
    const { IpcWatcher } = await import("./ipc-watcher.js");
    const watcher = new IpcWatcher(deps);

    try {
      await watcher.start();
      await new Promise((r) => setTimeout(r, 200));

      await writeIpcMessage("test-group", "live.json", {
        type: "message",
        chatJid: "group@g.us",
        text: "live message",
      });

      await new Promise((r) => setTimeout(r, 400));
      expect(deps.sendMessage).toHaveBeenCalledWith("group@g.us", "live message");
    } finally {
      watcher.stop();
    }
  });

  it("fallback poll picks up files when fs.watch is unavailable", async () => {
    const watchSpy = vi.spyOn(fs, "watch").mockImplementation(() => {
      throw new Error("fs.watch unavailable");
    });

    const deps = createDeps();
    const { IpcWatcher } = await import("./ipc-watcher.js");
    const watcher = new IpcWatcher(deps);

    try {
      await watcher.start();
      await new Promise((r) => setTimeout(r, 100));

      await writeIpcMessage("test-group", "fallback.json", {
        type: "message",
        chatJid: "group@g.us",
        text: "fallback message",
      });

      // Wait for fallback poll interval (200ms in test) + debounce (50ms) + processing
      await new Promise((r) => setTimeout(r, 500));
      expect(deps.sendMessage).toHaveBeenCalledWith("group@g.us", "fallback message");
    } finally {
      watcher.stop();
      watchSpy.mockRestore();
    }
  });
});
