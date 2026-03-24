import { spawn } from "child_process";
import fs from "fs";
import path from "path";

import { DATA_DIR } from "./config.js";
import { logger } from "./logger.js";

interface RemoteControlSession {
  pid: number;
  url: string;
  startedBy: string;
  startedInChat: string;
  startedAt: string;
}

let activeSession: RemoteControlSession | null = null;
let startupInProgress = false;

const URL_REGEX = /https:\/\/claude\.ai\/code\S+/;
const URL_TIMEOUT_MS = 30_000;
const URL_POLL_MS = 200;
const STATE_FILE = path.join(DATA_DIR, "remote-control.json");
const STDOUT_FILE = path.join(DATA_DIR, "remote-control.stdout");
const STDERR_FILE = path.join(DATA_DIR, "remote-control.stderr");

function saveState(session: RemoteControlSession): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(session), { mode: 0o600 });
}

function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore session from disk on startup.
 * If the process is still alive, adopt it. Otherwise, clean up.
 */
export function restoreRemoteControl(): void {
  let data: string;
  try {
    data = fs.readFileSync(STATE_FILE, "utf-8");
  } catch {
    return;
  }

  try {
    const session: RemoteControlSession = JSON.parse(data);
    if (session.pid && isProcessAlive(session.pid)) {
      activeSession = session;
      logger.info({ pid: session.pid }, "Restored Remote Control session from previous run");
    } else {
      clearState();
    }
  } catch {
    clearState();
  }
}

export function getActiveSession(): RemoteControlSession | null {
  return activeSession;
}

/** @internal — exported for testing only */
export function _resetForTesting(): void {
  activeSession = null;
  startupInProgress = false;
}

/** @internal — exported for testing only */
export function _getStateFilePath(): string {
  return STATE_FILE;
}

export async function startRemoteControl(
  sender: string,
  chatJid: string,
  cwd: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (activeSession) {
    // Verify the process is still alive
    if (isProcessAlive(activeSession.pid)) {
      return { ok: true, url: activeSession.url };
    }
    // Process died — clean up and start a new one
    activeSession = null;
    clearState();
  }

  // Prevent concurrent startup races — two calls before URL discovery
  // would both spawn detached processes with only one PID tracked.
  if (startupInProgress) {
    return { ok: false, error: "Remote Control startup already in progress" };
  }
  startupInProgress = true;

  // Redirect stdout/stderr to files so the process has no pipes to the parent.
  // This prevents SIGPIPE when NanoClaw restarts.
  // Use restrictive permissions (0o600) — these files may contain capability URLs.
  let stdoutFd: number;
  let stderrFd: number;
  let proc;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    stdoutFd = fs.openSync(STDOUT_FILE, "w", 0o600);
    stderrFd = fs.openSync(STDERR_FILE, "w", 0o600);
  } catch (err: any) {
    startupInProgress = false;
    return { ok: false, error: `Failed to set up files: ${err.message}` };
  }

  try {
    proc = spawn("claude", ["remote-control", "--name", "NanoClaw Remote"], {
      cwd,
      stdio: ["pipe", stdoutFd, stderrFd],
      detached: true,
    });
  } catch (err: any) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    startupInProgress = false;
    return { ok: false, error: `Failed to start: ${err.message}` };
  }

  // Auto-accept the "Enable Remote Control?" prompt
  if (proc.stdin) {
    proc.stdin.write("y\n");
    proc.stdin.end();
  }

  // Close FDs in the parent — the child inherited copies
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  // Fully detach from parent
  proc.unref();

  // Listen for async spawn errors (e.g. ENOENT when claude is not on PATH).
  // spawn() itself only throws synchronously for invalid arguments; missing
  // binaries emit an 'error' event on the ChildProcess.
  let spawnError: Error | null = null;
  proc.on("error", (err: Error) => {
    spawnError = err;
  });

  const pid = proc.pid;
  if (!pid) {
    startupInProgress = false;
    return { ok: false, error: "Failed to get process PID" };
  }

  // Poll the stdout file for the URL
  return new Promise<{ ok: true; url: string } | { ok: false; error: string }>((resolve) => {
    const startTime = Date.now();

    const poll = () => {
      // Check for async spawn failure
      if (spawnError) {
        resolve({ ok: false, error: `Failed to start: ${spawnError.message}` });
        return;
      }

      // Check if process died
      if (!isProcessAlive(pid)) {
        resolve({ ok: false, error: "Process exited before producing URL" });
        return;
      }

      // Check for URL in stdout file
      let content = "";
      try {
        content = fs.readFileSync(STDOUT_FILE, "utf-8");
      } catch {
        // File might not have content yet
      }

      const match = content.match(URL_REGEX);
      if (match) {
        const session: RemoteControlSession = {
          pid,
          url: match[0],
          startedBy: sender,
          startedInChat: chatJid,
          startedAt: new Date().toISOString(),
        };
        activeSession = session;
        saveState(session);

        logger.info({ pid, sender, chatJid }, "Remote Control session started");
        resolve({ ok: true, url: match[0] });
        return;
      }

      // Timeout check
      if (Date.now() - startTime >= URL_TIMEOUT_MS) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already dead
          }
        }
        resolve({
          ok: false,
          error: "Timed out waiting for Remote Control URL",
        });
        return;
      }

      setTimeout(poll, URL_POLL_MS);
    };

    poll();
  }).finally(() => {
    startupInProgress = false;
  });
}

export function stopRemoteControl():
  | {
      ok: true;
    }
  | { ok: false; error: string } {
  if (!activeSession) {
    return { ok: false, error: "No active Remote Control session" };
  }

  const { pid } = activeSession;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
  activeSession = null;
  clearState();
  logger.info({ pid }, "Remote Control session stopped");
  return { ok: true };
}
