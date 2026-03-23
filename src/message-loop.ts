/**
 * Message polling loop.
 * Extracted from index.ts for testability.
 */
import {
  ASSISTANT_NAME,
  INSTANCE_ID,
  MAX_PROMPT_MESSAGES,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from "./config.js";
import type { GroupQueue } from "./group-queue.js";
import { logger } from "./logger.js";
import { findChannel, formatMessagesWithCap } from "./router.js";
import { isTriggerAllowed, loadSenderAllowlist } from "./sender-allowlist.js";
import { extractSessionCommand, isSessionCommandAllowed } from "./session-commands.js";
import type { Channel, NewMessage, RegisteredGroup } from "./types.js";

interface MessageLoopDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  channels: () => Channel[];
  lastAgentTimestamp: () => Record<string, { ts: string; id: string }>;
  setLastAgentTimestamp: (jid: string, cursor: { ts: string; id: string }) => void;
  pendingTailDrain: () => ReadonlyMap<string, { ts: string; id: string }>;
  lastTimestamp: () => string;
  setLastTimestamp: (ts: string) => void;
  saveState: () => Promise<void>;
  queue: Pick<GroupQueue, "sendMessage" | "enqueueMessageCheck" | "closeStdin">;

  // DB
  getNewMessages: (
    jids: string[],
    sinceTimestamp: string,
    assistantName: string,
  ) => Promise<{ messages: NewMessage[]; newTimestamp: string }>;
  getMessagesSince: (
    chatJid: string,
    sinceTimestamp: string,
    assistantName: string,
    limit: number,
    sinceId?: string,
  ) => Promise<NewMessage[]>;
}

let messageLoopRunning = false;

/** @internal - for tests only. */
export function _resetMessageLoopForTests(): void {
  messageLoopRunning = false;
}

export async function startMessageLoop(deps: MessageLoopDeps): Promise<void> {
  if (messageLoopRunning) {
    logger.debug("Message loop already running, skipping duplicate start");
    return;
  }
  messageLoopRunning = true;

  logger.info({ instanceId: INSTANCE_ID }, `NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const registeredGroups = deps.registeredGroups();
      const channels = deps.channels();
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = await deps.getNewMessages(
        jids,
        deps.lastTimestamp(),
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, "New messages");

        // Advance the "seen" cursor for all messages immediately
        deps.setLastTimestamp(newTimestamp);
        await deps.saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, "No channel owns JID, skipping messages");
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Find the first *authorized* session command in the batch.
          // Scanning only the first command could miss an admin /compact that
          // follows an untrusted one in the same poll batch.
          const loopCmdMsg = groupMessages.find(
            (m) =>
              extractSessionCommand(m.content, TRIGGER_PATTERN) !== null &&
              isSessionCommandAllowed(isMainGroup, m.is_from_me === true),
          );

          if (loopCmdMsg) {
            // Close active container (no-ops when no container is active) and
            // enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            deps.queue.closeStdin(chatJid);
            deps.queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Don't pipe while tail-drain is pending — let processGroupMessages
          // handle the backlog first to avoid cursor jumps that skip messages.
          // Don't enqueue either — the tail-drain's own success/failure handlers
          // manage the next run, and an external enqueue defeats retry backoff.
          if (deps.pendingTailDrain().has(chatJid)) {
            continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const pipeCursor = deps.lastAgentTimestamp()[chatJid] || { ts: "", id: "" };
          const allPending = await deps.getMessagesSince(
            chatJid,
            pipeCursor.ts,
            ASSISTANT_NAME,
            MAX_PROMPT_MESSAGES,
            pipeCursor.id,
          );
          const messagesToSend = allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessagesWithCap(messagesToSend, TIMEZONE, MAX_PROMPT_MESSAGES);

          if (deps.queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              "Piped messages to active container",
            );
            const pipeLast = messagesToSend[messagesToSend.length - 1];
            deps.setLastAgentTimestamp(chatJid, { ts: pipeLast.timestamp, id: pipeLast.id });
            await deps.saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err: unknown) =>
                logger.warn({ chatJid, err }, "Failed to set typing indicator"),
              );
          } else {
            // No active container — enqueue for a new one
            deps.queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Error in message loop");
    }
    await new Promise((resolve) => {
      setTimeout(resolve, POLL_INTERVAL);
    });
  }
}
