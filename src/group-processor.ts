/**
 * Group message processing and agent execution.
 * Extracted from index.ts for testability.
 */
import type { ChildProcess } from "child_process";

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAX_PROMPT_MESSAGES,
  TIMEZONE,
  TRIGGER_PATTERN,
} from "./config.js";
import type { AvailableGroup, ContainerOutput } from "./container-runner.js";
import type { GroupQueue } from "./group-queue.js";
import { logger } from "./logger.js";
import { isAuthError } from "./auth-circuit-breaker.js";
import { decideCursorAction } from "./message-processing.js";
import { shouldSend, recordSent } from "./message-dedup.js";
import { anchorTriggerWindow, findChannel, formatMessagesWithCap } from "./router.js";
import { isTriggerAllowed, loadSenderAllowlist } from "./sender-allowlist.js";
import { handleSessionCommand } from "./session-commands.js";
import {
  PartialSendError,
  type Channel,
  type NewMessage,
  type RegisteredGroup,
  type ScheduledTask,
} from "./types.js";

interface GroupProcessorDeps {
  // State accessors
  registeredGroups: () => Record<string, RegisteredGroup>;
  channels: () => Channel[];
  lastAgentTimestamp: () => Record<string, { ts: string; id: string }>;
  setLastAgentTimestamp: (jid: string, cursor: { ts: string; id: string }) => void;
  sessions: () => Record<string, string>;
  setSession: (folder: string, sessionId: string) => Promise<void>;
  pendingTailDrain: () => Map<string, { ts: string; id: string }>;

  // Persistence
  saveState: () => Promise<void>;
  savePendingTailDrain: () => Promise<void>;

  // Queue (subset of GroupQueue methods used)
  queue: Pick<GroupQueue, "enqueueMessageCheck" | "closeStdin" | "notifyIdle" | "registerProcess">;

  // DB
  getAllMessagesSince: (
    chatJid: string,
    sinceTimestamp: string,
    assistantName: string,
    limit: number,
    sinceId?: string,
  ) => Promise<NewMessage[]>;
  getMessagesSince: (
    chatJid: string,
    sinceTimestamp: string,
    assistantName: string,
    limit: number,
    sinceId?: string,
  ) => Promise<NewMessage[]>;
  getAllTasks: () => Promise<ScheduledTask[]>;

  // Container operations
  runContainerAgent: (
    group: RegisteredGroup,
    input: {
      prompt: string;
      sessionId?: string;
      groupFolder: string;
      chatJid: string;
      isMain: boolean;
      assistantName: string;
      tanren?: { apiUrl: string; apiKey: string };
    },
    onProcess: (proc: ChildProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => Promise<ContainerOutput>;
  writeTasksSnapshot: (
    groupFolder: string,
    isMain: boolean,
    tasks: Array<{
      id: string;
      groupFolder: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      status: string;
      next_run: string | null;
    }>,
  ) => void;
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
  ) => void;
  getAvailableGroups: () => Promise<AvailableGroup[]>;
  readTanrenConfig: () => { apiUrl: string; apiKey: string } | null | undefined;
}

/**
 * Create a processGroupMessages function with injected dependencies.
 * Returns a closure compatible with queue.setProcessMessagesFn().
 */
export function createGroupProcessor(
  deps: GroupProcessorDeps,
): (chatJid: string) => Promise<boolean> {
  async function runAgent(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<"success" | "error"> {
    const isMain = group.isMain === true;
    const sessionId = deps.sessions()[group.folder];

    // Update tasks snapshot for container to read (filtered by group)
    const tasks = await deps.getAllTasks();
    deps.writeTasksSnapshot(
      group.folder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    // Update available groups snapshot (main group only can see all groups)
    const availableGroups = await deps.getAvailableGroups();
    deps.writeGroupsSnapshot(group.folder, isMain, availableGroups);

    // Wrap onOutput to track session ID from streamed results
    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId) {
            deps.sessions()[group.folder] = output.newSessionId;
            await deps.setSession(group.folder, output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    const tanrenConfig = isMain ? deps.readTanrenConfig() : undefined;

    try {
      const output = await deps.runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
          tanren: tanrenConfig ?? undefined,
        },
        (proc, containerName) =>
          deps.queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
      );

      if (output.newSessionId) {
        deps.sessions()[group.folder] = output.newSessionId;
        await deps.setSession(group.folder, output.newSessionId);
      }

      if (output.status === "error") {
        logger.error({ group: group.name, error: output.error }, "Container agent error");
        return "error";
      }

      return "success";
    } catch (err) {
      logger.error({ group: group.name, err }, "Agent error");
      return "error";
    }
  }

  return async function processGroupMessages(chatJid: string): Promise<boolean> {
    const group = deps.registeredGroups()[chatJid];
    if (!group) return true;

    const channel = findChannel(deps.channels(), chatJid);
    if (!channel) {
      logger.warn({ chatJid }, "No channel owns JID, skipping messages");
      return true;
    }

    const isMainGroup = group.isMain === true;
    const needsFullDrain = !isMainGroup && group.requiresTrigger !== false;
    const pendingTailDrain = deps.pendingTailDrain();

    // Clear stale tail-drain entry if the group no longer needs full drain
    // (e.g., requiresTrigger changed to false, or group became main).
    // The bounded path doesn't touch pendingTailDrain, and the poll guard
    // would block the group indefinitely if the entry persists.
    if (!needsFullDrain && pendingTailDrain.delete(chatJid)) {
      await deps.savePendingTailDrain();
    }

    const cursor = deps.lastAgentTimestamp()[chatJid] || { ts: "", id: "" };
    let missedMessages = needsFullDrain
      ? await deps.getAllMessagesSince(chatJid, cursor.ts, ASSISTANT_NAME, 200, cursor.id)
      : await deps.getMessagesSince(
          chatJid,
          cursor.ts,
          ASSISTANT_NAME,
          MAX_PROMPT_MESSAGES,
          cursor.id,
        );

    if (missedMessages.length === 0) {
      if (pendingTailDrain.delete(chatJid)) await deps.savePendingTailDrain();
      return true;
    }

    // --- Session command interception (before trigger check) ---
    const cmdResult = await handleSessionCommand({
      missedMessages,
      isMainGroup,
      groupName: group.name,
      triggerPattern: TRIGGER_PATTERN,
      timezone: TIMEZONE,
      deps: {
        sendMessage: (text) => channel.sendMessage(chatJid, text),
        setTyping: (typing) => channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
        runAgent: (prompt, onOutput) => runAgent(group, prompt, chatJid, onOutput),
        closeStdin: () => deps.queue.closeStdin(chatJid),
        advanceCursor: async (ts, id) => {
          deps.setLastAgentTimestamp(chatJid, { ts, id });
          await deps.saveState();
        },
        formatMessages: (msgs, tz) => formatMessagesWithCap(msgs, tz, MAX_PROMPT_MESSAGES),
        canSenderInteract: (msg) => {
          const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
          const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
          return (
            isMainGroup ||
            !reqTrigger ||
            (hasTrigger &&
              (msg.is_from_me || isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
          );
        },
      },
    });
    if (cmdResult.handled) {
      // Always re-enqueue on success. The global "seen" cursor already
      // advanced past the batch, so getNewMessages won't return remaining
      // messages — the queue is the only way to pick up trailing work,
      // active tail-drains, or commands left pending after partial failures.
      // On failure, the queue's retry backoff handles re-processing.
      if (cmdResult.success) {
        deps.queue.enqueueMessageCheck(chatJid);
      }
      return cmdResult.success;
    }
    // --- End session command interception ---

    // Whether the trigger window was truncated (tail messages still need processing).
    // Only set for non-main groups with trigger requirements.
    let truncated = false;
    let isTailDrain = false;
    let tailDrainCutoff: { ts: string; id: string } | null = null;
    // Capture the last message's cursor for use as cutoff on first truncation.
    const fullBacklogLast =
      missedMessages.length > 0
        ? {
            ts: missedMessages[missedMessages.length - 1].timestamp,
            id: missedMessages[missedMessages.length - 1].id,
          }
        : null;
    // Track whether we deleted from pendingTailDrain (for persisting on early returns).
    let wasTailDrain = false;

    // For non-main groups, check if trigger is required and present
    if (needsFullDrain) {
      tailDrainCutoff = pendingTailDrain.get(chatJid) ?? null;
      wasTailDrain = pendingTailDrain.delete(chatJid);
      isTailDrain = wasTailDrain;
      // DB save deferred until batch completes (crash safety)
      if (isTailDrain) {
        // Continuation of a truncated trigger window — skip trigger requirement.
        // Filter to messages at or before the cutoff so post-cutoff messages
        // get normal trigger-gated processing.
        if (tailDrainCutoff && tailDrainCutoff.ts !== "") {
          const cutoffIdx = missedMessages.findIndex(
            (m) =>
              m.timestamp > tailDrainCutoff!.ts ||
              (m.timestamp === tailDrainCutoff!.ts && m.id > tailDrainCutoff!.id),
          );
          if (cutoffIdx === 0) {
            // All messages are past cutoff — tail-drain is complete
            isTailDrain = false;
          } else if (cutoffIdx > 0) {
            missedMessages = missedMessages.slice(0, cutoffIdx);
          }
          // cutoffIdx === -1: all messages at/before cutoff — process all
        }
        // Cap at MAX_PROMPT_MESSAGES; overflow re-enters next cycle
        if (isTailDrain && missedMessages.length > MAX_PROMPT_MESSAGES) {
          truncated = true;
          missedMessages = missedMessages.slice(0, MAX_PROMPT_MESSAGES);
        }
      }
      if (!isTailDrain) {
        // Normal path: require a trigger
        const allowlistCfg = loadSenderAllowlist();
        const triggerIdx = missedMessages.findIndex(
          (m) =>
            TRIGGER_PATTERN.test(m.content.trim()) &&
            (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
        );
        if (triggerIdx < 0) {
          if (wasTailDrain) await deps.savePendingTailDrain();
          return true;
        }
        const total = missedMessages.length;
        const window = anchorTriggerWindow(total, triggerIdx, MAX_PROMPT_MESSAGES);
        truncated = window.truncated;
        missedMessages = missedMessages.slice(window.start, window.end);
      }
    }

    const prompt = formatMessagesWithCap(missedMessages, TIMEZONE, MAX_PROMPT_MESSAGES);

    // Advance cursor so the piping path in startMessageLoop won't re-fetch
    // these messages. Save the old cursor so we can roll back on error.
    const previousCursor = deps.lastAgentTimestamp()[chatJid] || { ts: "", id: "" };
    const last = missedMessages[missedMessages.length - 1];
    deps.setLastAgentTimestamp(chatJid, { ts: last.timestamp, id: last.id });
    // Pre-persist tail-drain marker alongside cursor to prevent crash-window data loss.
    // If truncated, overflow messages exist beyond this batch — record the cutoff
    // so recovery can continue the drain even if the process crashes during agent execution.
    if (truncated) {
      const cutoff = isTailDrain && tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast!;
      pendingTailDrain.set(chatJid, cutoff);
      await deps.savePendingTailDrain();
    }
    await deps.saveState();

    logger.info({ group: group.name, messageCount: missedMessages.length }, "Processing messages");

    // Track idle timer for closing stdin when agent is idle
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug({ group: group.name }, "Idle timeout, closing container stdin");
        deps.queue.closeStdin(chatJid);
      }, IDLE_TIMEOUT);
    };

    await channel.setTyping?.(chatJid, true);
    let hadError = false;
    let hadSendError = false;
    let outputSentToUser = false;

    const output = await runAgent(group, prompt, chatJid, async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === "string" ? result.result : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim();
        logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
        if (text) {
          // Suppress auth error messages from reaching Discord
          if (isAuthError(text)) {
            logger.warn({ group: group.name }, "Suppressed auth error from Discord output");
          } else if (!shouldSend(chatJid, text)) {
            logger.warn({ group: group.name }, "Suppressed duplicate message from Discord output");
          } else {
            try {
              await channel.sendMessage(chatJid, text);
              recordSent(chatJid, text);
              outputSentToUser = true;
            } catch (err) {
              hadSendError = true;
              if (err instanceof PartialSendError) {
                outputSentToUser = true;
                logger.warn(
                  {
                    group: group.name,
                    chatJid,
                    chunksSent: err.chunksSent,
                    totalChunks: err.totalChunks,
                  },
                  "Partial send: some chunks delivered, skipping cursor rollback",
                );
              } else {
                logger.error(
                  { group: group.name, chatJid, err },
                  "Failed to send output to channel",
                );
              }
            }
          }
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === "success") {
        deps.queue.notifyIdle(chatJid);
      }

      if (result.status === "error") {
        hadError = true;
      }
    });

    await channel.setTyping?.(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);

    const decision = decideCursorAction({
      hadError: output === "error" || hadError,
      hadSendError,
      outputSentToUser,
      truncated,
      isTailDrain,
      wasTailDrain,
    });

    if (decision.shouldRollback) {
      deps.setLastAgentTimestamp(chatJid, previousCursor);
      await deps.saveState();
      if (isTailDrain) {
        pendingTailDrain.set(chatJid, tailDrainCutoff?.ts ? tailDrainCutoff : fullBacklogLast!);
      }
      if (decision.shouldClearTailDrain) {
        pendingTailDrain.delete(chatJid);
      }
      logger.warn({ group: group.name }, "Cursor rolled back for retry");
    }

    if (decision.shouldPersistTailDrain) {
      await deps.savePendingTailDrain();
    }

    if (decision.shouldEnqueue) {
      deps.queue.enqueueMessageCheck(chatJid);
    }

    return decision.succeeded;
  };
}
