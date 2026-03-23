/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 * Extracted from index.ts for testability.
 */
import type { GroupQueue } from "./group-queue.js";
import { logger } from "./logger.js";
import type { RegisteredGroup } from "./types.js";

interface RecoveryDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  lastAgentTimestamp: () => Record<string, { ts: string; id: string }>;
  pendingTailDrain: () => Map<string, { ts: string; id: string }>;
  queue: Pick<GroupQueue, "enqueueMessageCheck">;
  savePendingTailDrain: () => Promise<void>;
  getMessagesSince: (
    chatJid: string,
    sinceTimestamp: string,
    assistantName: string,
    limit: number,
    sinceId?: string,
  ) => Promise<Array<{ timestamp: string; id: string }>>;
  ASSISTANT_NAME: string;
}

export async function recoverPendingMessages(deps: RecoveryDeps): Promise<void> {
  const registeredGroups = deps.registeredGroups();
  const pendingTailDrain = deps.pendingTailDrain();
  const lastAgentTimestamp = deps.lastAgentTimestamp();

  // Phase 1: Enqueue groups with pending tail-drain entries from the DB.
  // After a crash, the entry may survive even though no messages remain
  // at the cutoff — processGroupMessages will clear it.
  const phase1Enqueued = new Set<string>();
  let removedStale = false;
  for (const chatJid of pendingTailDrain.keys()) {
    if (registeredGroups[chatJid]) {
      logger.info(
        { group: registeredGroups[chatJid].name },
        "Recovery: resuming pending tail-drain",
      );
      deps.queue.enqueueMessageCheck(chatJid);
      phase1Enqueued.add(chatJid);
    } else {
      pendingTailDrain.delete(chatJid);
      removedStale = true;
    }
  }
  if (removedStale) await deps.savePendingTailDrain();

  // Phase 2: Enqueue groups with unprocessed messages at the cursor.
  // Skip groups already enqueued in Phase 1 — a second enqueue while
  // the first run is active sets pendingMessages=true, which defeats
  // retry backoff if the run fails.
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (phase1Enqueued.has(chatJid)) continue;
    const recoverCursor = lastAgentTimestamp[chatJid] || { ts: "", id: "" };
    const pending = await deps.getMessagesSince(
      chatJid,
      recoverCursor.ts,
      deps.ASSISTANT_NAME,
      1,
      recoverCursor.id,
    );
    if (pending.length > 0) {
      logger.info({ group: group.name }, "Recovery: found unprocessed messages");
      deps.queue.enqueueMessageCheck(chatJid);
    }
  }
}
