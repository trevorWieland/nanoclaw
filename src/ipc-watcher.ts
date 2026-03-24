/**
 * Event-based IPC watcher using fs.watch with debounce and fallback polling.
 * Replaces the previous setTimeout-based polling loop for lower latency
 * and reduced CPU usage on idle directories.
 */
import fs from "fs";
import { mkdir } from "fs/promises";
import path from "path";

import { DATA_DIR, IPC_DEBOUNCE_MS, IPC_FALLBACK_POLL_INTERVAL } from "./config.js";
import { processIpcFiles, type IpcDeps } from "./ipc.js";
import { logger } from "./logger.js";

export class IpcWatcher {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;
  private pendingProcess = false;
  private readonly ipcBaseDir: string;
  private readonly deps: IpcDeps;

  constructor(deps: IpcDeps) {
    this.deps = deps;
    this.ipcBaseDir = path.join(DATA_DIR, "ipc");
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.debug("IPC watcher already running, skipping duplicate start");
      return;
    }
    this.running = true;

    await mkdir(this.ipcBaseDir, { recursive: true });

    this.startFsWatcher();

    // Safety-net fallback poll — catches dropped inotify events
    this.fallbackInterval = setInterval(() => {
      this.scheduleProcess();
    }, IPC_FALLBACK_POLL_INTERVAL);

    // Initial process to pick up any files that arrived before the watcher started
    this.scheduleProcess();

    logger.info("IPC watcher started (fs.watch + fallback poll)");
  }

  stop(): void {
    this.running = false;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    logger.info("IPC watcher stopped");
  }

  private startFsWatcher(): void {
    try {
      this.watcher = fs.watch(this.ipcBaseDir, { recursive: true }, () => {
        this.scheduleProcess();
      });

      this.watcher.on("error", (err) => {
        logger.warn({ err }, "fs.watch error, will rely on fallback polling");
        this.watcher?.close();
        this.watcher = null;
        // Try to restart the watcher after a delay
        if (this.running) {
          this.restartTimer = setTimeout(() => this.startFsWatcher(), IPC_FALLBACK_POLL_INTERVAL);
        }
      });
    } catch (err) {
      logger.warn({ err }, "Failed to start fs.watch, relying on fallback polling");
    }
  }

  private scheduleProcess(): void {
    if (!this.running) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.runProcess();
    }, IPC_DEBOUNCE_MS);
  }

  private async runProcess(): Promise<void> {
    // Prevent overlapping processing. If already processing, mark as pending
    // so we re-run after the current pass completes.
    if (this.processing) {
      this.pendingProcess = true;
      return;
    }
    this.processing = true;

    try {
      await processIpcFiles(this.ipcBaseDir, this.deps);
    } catch (err) {
      logger.error({ err }, "Error in IPC file processing");
    } finally {
      this.processing = false;
      if (this.pendingProcess) {
        this.pendingProcess = false;
        this.scheduleProcess();
      }
    }
  }
}
