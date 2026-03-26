/**
 * Shared test utilities for integration tests.
 *
 * Provides MockChannel (implements Channel interface), FakeContainerProcess
 * (simulates child_process.spawn for container-runner), and factory helpers
 * for test data.
 */
import { EventEmitter } from "events";
import { PassThrough } from "stream";

import type { Channel, NewMessage, RegisteredGroup } from "../types.js";

// Sentinel markers — must match container-runner.ts
export const OUTPUT_START_MARKER = "---NANOCLAW_OUTPUT_START---";
export const OUTPUT_END_MARKER = "---NANOCLAW_OUTPUT_END---";

// ─── MockChannel ───────────────────────────────────────────────────

export class MockChannel implements Channel {
  name: string;
  sentMessages: Array<{ jid: string; text: string }> = [];
  typingState = new Map<string, boolean>();
  sendMessageImpl: (jid: string, text: string) => Promise<void>;

  private connected = true;
  private jidPattern: (jid: string) => boolean;

  constructor(opts?: {
    jidPattern?: (jid: string) => boolean;
    name?: string;
    sendMessageImpl?: (jid: string, text: string) => Promise<void>;
  }) {
    this.name = opts?.name ?? "mock";
    this.jidPattern = opts?.jidPattern ?? ((jid) => jid.endsWith("@test"));
    this.sendMessageImpl =
      opts?.sendMessageImpl ??
      (async (jid, text) => {
        this.sentMessages.push({ jid, text });
      });
  }

  async connect() {
    this.connected = true;
  }

  async sendMessage(jid: string, text: string) {
    await this.sendMessageImpl(jid, text);
  }

  isConnected() {
    return this.connected;
  }

  ownsJid(jid: string) {
    return this.jidPattern(jid);
  }

  async disconnect() {
    this.connected = false;
  }

  async setTyping(jid: string, isTyping: boolean) {
    this.typingState.set(jid, isTyping);
  }

  reset() {
    this.sentMessages = [];
    this.typingState.clear();
  }
}

// ─── FakeContainerProcess ──────────────────────────────────────────

interface ContainerOutputPayload {
  status: "success" | "error";
  result?: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Simulates a Docker container ChildProcess for the container-runner.
 * Captures stdin, emits sentinel-wrapped output on stdout, and fires
 * the "close" event with a configurable exit code.
 *
 * Based on the createFakeProcess() pattern from container-runner.test.ts.
 */
export class FakeContainerProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = () => {};
  pid = 99999;

  private stdinChunks: Buffer[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.stdinChunks.push(chunk));
  }

  /** Get the parsed ContainerInput that was written to stdin. */
  getStdinInput(): Record<string, unknown> {
    return JSON.parse(Buffer.concat(this.stdinChunks).toString());
  }

  /** Emit a sentinel-wrapped output on stdout (simulates agent response). */
  emitOutput(output: ContainerOutputPayload) {
    const json = JSON.stringify(output);
    this.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
  }

  /** Emit text on stderr (simulates container debug logs). */
  emitStderr(text: string) {
    this.stderr.push(text);
  }

  /** Complete the container run: EOF streams + close event. */
  close(exitCode = 0) {
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("close", exitCode);
  }
}

// ─── Factory helpers ───────────────────────────────────────────────

export function makeTestMessage(
  id: string,
  content: string,
  timestamp: string,
  overrides?: Partial<NewMessage>,
): NewMessage {
  return {
    id,
    chat_jid: overrides?.chat_jid ?? "group@test",
    sender: overrides?.sender ?? "user1",
    sender_name: overrides?.sender_name ?? "User",
    content,
    timestamp,
    is_from_me: overrides?.is_from_me ?? false,
    is_bot_message: overrides?.is_bot_message ?? false,
  };
}

export function makeTestGroup(
  folder: string,
  overrides?: Partial<RegisteredGroup>,
): RegisteredGroup {
  return {
    name: overrides?.name ?? folder.charAt(0).toUpperCase() + folder.slice(1),
    folder,
    trigger: overrides?.trigger ?? "@Andy",
    added_at: overrides?.added_at ?? "2024-01-01",
    isMain: overrides?.isMain ?? false,
    requiresTrigger: overrides?.requiresTrigger,
    containerConfig: overrides?.containerConfig,
  };
}
