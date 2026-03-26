/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from "fs";
import { access, mkdir, readdir, readFile, unlink } from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { query, HookCallback, PreCompactHookInput } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "url";
import { z } from "zod";
import { buildMcpServers } from "./mcp-proxy.js";

const ContainerInputSchema = z.object({
  prompt: z.string(),
  sessionId: z.string().optional(),
  groupFolder: z.string(),
  chatJid: z.string(),
  isMain: z.boolean(),
  isScheduledTask: z.boolean().optional(),
  assistantName: z.string().optional(),
  script: z.string().optional(),
  mcpServers: z
    .record(
      z.string(),
      z.object({
        type: z.enum(["http", "sse"]),
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
      }),
    )
    .optional(),
});

type ContainerInput = z.infer<typeof ContainerInputSchema>;

const FollowUpMessageSchema = z.object({
  type: z.literal("message"),
  text: z.string().min(1),
});

interface ContainerOutput {
  status: "success" | "error";
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = "/workspace/ipc/input";
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, "_close");
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

const OUTPUT_START_MARKER = "---NANOCLAW_OUTPUT_START---";
const OUTPUT_END_MARKER = "---NANOCLAW_OUTPUT_END---";

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, "sessions-index.json");

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log("No transcript found for archiving");
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, "utf-8");
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log("No messages to archive");
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = "/workspace/group/conversations";
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split("T")[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, "0")}${time.getMinutes().toString().padStart(2, "0")}`;
}

interface ParsedMessage {
  role: "user" | "assistant";
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "user" && entry.message?.content) {
        const text =
          typeof entry.message.content === "string"
            ? entry.message.content
            : entry.message.content.map((c: { text?: string }) => c.text || "").join("");
        if (text) messages.push({ role: "user", content: text });
      } else if (entry.type === "assistant" && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text);
        const text = textParts.join("");
        if (text) messages.push({ role: "assistant", content: text });
      }
    } catch {}
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || "Conversation"}`);
  lines.push("");
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const msg of messages) {
    const sender = msg.role === "user" ? "User" : assistantName || "Assistant";
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + "..." : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Check for _close sentinel.
 */
async function shouldClose(): Promise<boolean> {
  try {
    await access(IPC_INPUT_CLOSE_SENTINEL);
    try {
      await unlink(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
async function drainIpcInput(): Promise<string[]> {
  try {
    await mkdir(IPC_INPUT_DIR, { recursive: true });
    const files = (await readdir(IPC_INPUT_DIR)).filter((f) => f.endsWith(".json")).sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const raw = JSON.parse(await readFile(filePath, "utf-8"));
        await unlink(filePath);
        const parsed = FollowUpMessageSchema.safeParse(raw);
        if (parsed.success) {
          messages.push(parsed.data.text);
        } else {
          log(`Invalid IPC input message in ${file}: ${parsed.error.message}`);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          await unlink(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

const IPC_WAIT_DEBOUNCE_MS = 50;
const IPC_WAIT_MAX_DEFER_MS = IPC_WAIT_DEBOUNCE_MS * 5;
const IPC_WAIT_FALLBACK_MS = 2000;

/**
 * Wait for a new IPC message or _close sentinel.
 * Uses fs.watch for immediate notification with a slow-poll fallback.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    let resolved = false;
    let checking = false;
    let watcher: fs.FSWatcher | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let burstStart = 0;

    const cleanup = () => {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const check = async () => {
      if (resolved || checking) return;
      checking = true;
      try {
        if (await shouldClose()) {
          resolved = true;
          cleanup();
          resolve(null);
          return;
        }
        const messages = await drainIpcInput();
        if (messages.length > 0) {
          resolved = true;
          cleanup();
          resolve(messages.join("\n"));
        }
      } finally {
        checking = false;
      }
    };

    const scheduleCheck = () => {
      if (resolved) return;

      const now = Date.now();
      if (!burstStart) burstStart = now;

      // If events have been deferring check() beyond the max-wait cap, fire immediately
      if (now - burstStart >= IPC_WAIT_MAX_DEFER_MS) {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        burstStart = 0;
        check();
        return;
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        burstStart = 0;
        check();
      }, IPC_WAIT_DEBOUNCE_MS);
    };

    // Set up fs.watch on the input directory
    try {
      watcher = fs.watch(IPC_INPUT_DIR, () => {
        scheduleCheck();
      });
      watcher.on("error", () => {
        watcher = null;
        // Fallback interval continues to handle it
      });
    } catch {
      // fs.watch failed to start; fallback polling handles it
    }

    // Safety-net slow poll — calls check() directly, bypassing debounce
    fallbackTimer = setInterval(() => check(), IPC_WAIT_FALLBACK_MS);

    // Initial check (files may have arrived before watcher was set up)
    check();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  bridgePath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query.
  // Re-check ipcPolling after each await to avoid pushing into a finished stream.
  let ipcPolling = true;
  let closedDuringQuery = false;
  let inflightPoll: Promise<void> | null = null;
  const pollIpcDuringQuery = async () => {
    if (!ipcPolling) return;
    if (await shouldClose()) {
      // Always honour _close — the sentinel was already consumed from disk.
      // Even if the query finished during the await, closedDuringQuery must
      // be set so the outer loop exits instead of waiting for a new signal.
      log("Close sentinel detected during query, ending stream");
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    if (!ipcPolling) return;
    const messages = await drainIpcInput();
    if (!ipcPolling) {
      // Query finished while we were draining. These messages were already
      // unlinked — re-write them so the next waitForIpcMessage picks them up.
      for (const text of messages) {
        const file = path.join(
          IPC_INPUT_DIR,
          `rescued-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
        );
        try {
          fs.writeFileSync(file, JSON.stringify({ type: "message", text }));
        } catch {
          log(`Failed to rescue IPC message (${text.length} chars)`);
        }
      }
      return;
    }
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    if (ipcPolling) {
      setTimeout(startPoll, IPC_POLL_MS);
    }
  };
  const startPoll = () => {
    inflightPoll = pollIpcDuringQuery();
  };
  setTimeout(startPoll, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = "/workspace/global/CLAUDE.md";
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, "utf-8");
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = "/workspace/extra";
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(", ")}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: "/workspace/group",
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: "preset" as const, preset: "claude_code" as const, append: globalClaudeMd }
        : undefined,
      allowedTools: (() => {
        const tools = [
          "Bash",
          "Read",
          "Write",
          "Edit",
          "Glob",
          "Grep",
          "WebSearch",
          "WebFetch",
          "Task",
          "TaskOutput",
          "TaskStop",
          "TeamCreate",
          "TeamDelete",
          "SendMessage",
          "TodoWrite",
          "ToolSearch",
          "Skill",
          "NotebookEdit",
          "mcp__nanoclaw__*",
        ];
        if (containerInput.mcpServers) {
          for (const name of Object.keys(containerInput.mcpServers)) {
            tools.push(`mcp__${name}__*`);
          }
        }
        return tools;
      })(),
      env: sdkEnv,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project", "user"],
      mcpServers: buildMcpServers(mcpServerPath, bridgePath, containerInput),
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    },
  })) {
    messageCount++;
    const msgType =
      message.type === "system"
        ? `system/${(message as { subtype?: string }).subtype}`
        : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === "assistant" && "uuid" in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === "system" && message.subtype === "init") {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (
      message.type === "system" &&
      (message as { subtype?: string }).subtype === "task_notification"
    ) {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === "result") {
      resultCount++;
      const textResult = "result" in message ? (message as { result?: string }).result : null;
      log(
        `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ""}`,
      );
      writeOutput({
        status: "success",
        result: textResult || null,
        newSessionId,
      });
    }
  }

  ipcPolling = false;

  // Wait for any in-flight async poll callback to finish. It may still be
  // inside await shouldClose/drainIpcInput and could update closedDuringQuery.
  if (inflightPoll) {
    await inflightPoll;
  }

  // Also re-check the sentinel directly in case _close arrived after the last poll
  // but before we stopped polling — avoids a missed shutdown.
  if (!closedDuringQuery && (await shouldClose())) {
    log("Close sentinel found after query completion");
    closedDuringQuery = true;
  }

  log(
    `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || "none"}, closedDuringQuery: ${closedDuringQuery}`,
  );
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;

async function runScript(
  script: string,
  groupWorkspace = "/workspace/group",
): Promise<ScriptResult | null> {
  const scriptPath = "/tmp/task-script.sh";
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      "bash",
      [scriptPath],
      {
        cwd: groupWorkspace,
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        // Parse last non-empty line of stdout as JSON
        const lines = stdout.trim().split("\n");
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log("Script produced no output");
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine);
          if (typeof result.wakeAgent !== "boolean") {
            log(`Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`);
            return resolve(null);
          }
          resolve(result as ScriptResult);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = ContainerInputSchema.parse(JSON.parse(stdinData));
    try {
      fs.unlinkSync("/tmp/input.json");
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: "error",
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, "ipc-mcp-stdio.js");
  const bridgePath = path.join(__dirname, "mcp-http-bridge.js");
  let sessionId = containerInput.sessionId;
  await mkdir(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try {
    await unlink(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // --- Slash command detection (before IPC drain) ---
  // Evaluate command status from the original prompt before appending drained
  // IPC messages, so leftover IPC content doesn't break the exact-match check.
  const KNOWN_SESSION_COMMANDS = new Set(["/compact"]);
  const isSessionSlashCommand = KNOWN_SESSION_COMMANDS.has(containerInput.prompt.trim());

  // Build initial prompt (drain any pending IPC messages too).
  // Skip IPC drain for slash commands — they run in isolation and drained
  // messages would be deleted but never processed, losing user input.
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  if (!isSessionSlashCommand) {
    const pending = await drainIpcInput();
    if (pending.length > 0) {
      log(`Draining ${pending.length} pending IPC messages into initial prompt`);
      prompt += "\n" + pending.join("\n");
    }
  }

  const trimmedPrompt = prompt.trim();

  if (isSessionSlashCommand) {
    // Use the original prompt for the SDK call, not the IPC-contaminated one.
    // Drained IPC messages are irrelevant for slash commands and would prevent
    // the SDK from recognizing the command.
    const slashPrompt = containerInput.prompt.trim();
    log(`Handling session command: ${slashPrompt}`);
    let slashSessionId: string | undefined;
    let compactBoundarySeen = false;
    let hadError = false;
    let resultEmitted = false;

    try {
      for await (const message of query({
        prompt: slashPrompt,
        options: {
          cwd: "/workspace/group",
          resume: sessionId,
          systemPrompt: undefined,
          allowedTools: [],
          mcpServers: buildMcpServers(mcpServerPath, bridgePath, containerInput),
          env: sdkEnv,
          permissionMode: "bypassPermissions" as const,
          allowDangerouslySkipPermissions: true,
          settingSources: ["project", "user"] as const,
          hooks: {
            PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
          },
        },
      })) {
        const msgType =
          message.type === "system"
            ? `system/${(message as { subtype?: string }).subtype}`
            : message.type;
        log(`[slash-cmd] type=${msgType}`);

        if (message.type === "system" && message.subtype === "init") {
          slashSessionId = message.session_id;
          log(`Session after slash command: ${slashSessionId}`);
        }

        // Observe compact_boundary to confirm compaction completed
        if (
          message.type === "system" &&
          (message as { subtype?: string }).subtype === "compact_boundary"
        ) {
          compactBoundarySeen = true;
          log("Compact boundary observed — compaction completed");
        }

        if (message.type === "result") {
          const resultSubtype = (message as { subtype?: string }).subtype;
          const textResult = "result" in message ? (message as { result?: string }).result : null;

          if (resultSubtype?.startsWith("error")) {
            hadError = true;
            writeOutput({
              status: "error",
              result: null,
              error: textResult || "Session command failed.",
              newSessionId: slashSessionId,
            });
          } else {
            writeOutput({
              status: "success",
              result: textResult || "Conversation compacted.",
              newSessionId: slashSessionId,
            });
          }
          resultEmitted = true;
        }
      }
    } catch (err) {
      hadError = true;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Slash command error: ${errorMsg}`);
      writeOutput({ status: "error", result: null, error: errorMsg });
    }

    log(`Slash command done. compactBoundarySeen=${compactBoundarySeen}, hadError=${hadError}`);

    // Warn if compact_boundary was never observed — compaction may not have occurred
    if (!hadError && !compactBoundarySeen) {
      log("WARNING: compact_boundary was not observed. Compaction may not have completed.");
    }

    // Only emit final session marker if no result was emitted yet and no error occurred
    if (!resultEmitted && !hadError) {
      writeOutput({
        status: "success",
        result: compactBoundarySeen
          ? "Conversation compacted."
          : "Compaction requested but compact_boundary was not observed.",
        newSessionId: slashSessionId,
      });
    } else if (!hadError) {
      // Emit session-only marker so host updates session tracking
      writeOutput({ status: "success", result: null, newSessionId: slashSessionId });
    }
    return;
  }
  // --- End slash command handling ---

  // Script phase: run script before waking agent
  if (containerInput.script && containerInput.isScheduledTask) {
    log("Running task script...");
    const scriptResult = await runScript(containerInput.script);

    if (!scriptResult || !scriptResult.wakeAgent) {
      const reason = scriptResult ? "wakeAgent=false" : "script error/no output";
      log(`Script decided not to wake agent: ${reason}`);
      writeOutput({
        status: "success",
        result: null,
      });
      return;
    }

    // Script says wake agent — enrich prompt with script data.
    // Use the current `prompt` (which already has the [SCHEDULED TASK] prefix
    // and any drained IPC messages appended) rather than containerInput.prompt,
    // so pending user messages are not silently lost.
    log("Script wakeAgent=true, enriching prompt with data");
    if (scriptResult.data !== undefined) {
      prompt = `${prompt}\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}`;
    }
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || "new"}, resumeAt: ${resumeAt || "latest"})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerPath,
        bridgePath,
        containerInput,
        sdkEnv,
        resumeAt,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log("Close sentinel consumed during query, exiting");
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: "success", result: null, newSessionId: sessionId });

      log("Query ended, waiting for next IPC message...");

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log("Close sentinel received, exiting");
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: "error",
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
