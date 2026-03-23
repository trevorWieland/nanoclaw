/**
 * NanoClaw host orchestrator — thin composition root.
 * Docs map:
 * - docs/SPEC.md#message-flow
 * - docs/SPEC.md#deployment
 * - docs/ARCHITECTURE.md#3-multi-channel-pattern
 * Fork-specific rationale:
 * - Maintains main/non-main group boundaries described in docs/FORK_OVERVIEW.md.
 */
import fs from "fs";
import path from "path";

import { ASSISTANT_NAME, CREDENTIAL_PROXY_PORT, STATUS_BIND_HOST, STATUS_PORT } from "./config.js";
import { startCredentialProxy } from "./credential-proxy.js";
import { loadDeclarativeGroups } from "./declarative-groups.js";
import "./channels/index.js";
import { getChannelFactory, getRegisteredChannelNames } from "./channels/registry.js";
import { runContainerAgent, writeGroupsSnapshot, writeTasksSnapshot } from "./container-runner.js";
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from "./container-runtime.js";
import {
  getAllChats,
  getAllMessagesSince,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from "./db.js";
import { GroupQueue } from "./group-queue.js";
import { resolveGroupFolderPath } from "./group-folder.js";
import { createGroupProcessor } from "./group-processor.js";
import { startIpcWatcher } from "./ipc.js";
import { startMessageLoop } from "./message-loop.js";
import { recoverPendingMessages } from "./recovery.js";
import { findChannel, formatOutbound } from "./router.js";
import { isSenderAllowed, loadSenderAllowlist, shouldDropMessage } from "./sender-allowlist.js";
import { syncProjectMeta } from "./project-meta.js";
import { startSchedulerLoop } from "./task-scheduler.js";
import { createTanrenClient, readTanrenConfig } from "./tanren/index.js";
import { loadHealthMonitorConfig } from "./health-monitor-config.js";
import { getHealthSnapshot, getRecentEvents, startHealthMonitor } from "./health-monitor.js";
import type { HealthSource } from "./health-monitor.js";
import { startStatusServer } from "./status-server.js";
import { TanrenHealthSource } from "./health-sources/tanren.js";
import { renderEmbedAsText } from "./health-embeds.js";
import { Channel, NewMessage, RegisteredGroup } from "./types.js";
import { logger } from "./logger.js";

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from "./router.js";

let lastTimestamp = "";
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, { ts: string; id: string }> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();
const pendingTailDrain = new Map<string, { ts: string; id: string }>();

async function loadState(): Promise<void> {
  lastTimestamp = (await getRouterState("last_timestamp")) || "";
  const agentTs = await getRouterState("last_agent_timestamp");
  try {
    const raw: Record<string, string | { ts: string; id: string }> = agentTs
      ? JSON.parse(agentTs)
      : {};
    lastAgentTimestamp = {};
    for (const [key, val] of Object.entries(raw)) {
      lastAgentTimestamp[key] = typeof val === "string" ? { ts: val, id: "" } : val;
    }
  } catch (err) {
    logger.warn({ err, raw: agentTs }, "Corrupted last_agent_timestamp in DB, resetting");
    lastAgentTimestamp = {};
  }
  const tailDrainRaw = await getRouterState("pending_tail_drain");
  try {
    const parsed = tailDrainRaw ? JSON.parse(tailDrainRaw) : {};
    pendingTailDrain.clear();
    if (Array.isArray(parsed)) {
      // Migration: old format was ["jid1", "jid2"]
      for (const jid of parsed) pendingTailDrain.set(jid, { ts: "", id: "" });
    } else {
      for (const [jid, cursor] of Object.entries(parsed)) {
        pendingTailDrain.set(jid, cursor as { ts: string; id: string });
      }
    }
  } catch (err) {
    logger.warn({ err, raw: tailDrainRaw }, "Corrupted pending_tail_drain in DB, resetting");
    pendingTailDrain.clear();
  }
  sessions = await getAllSessions();
  registeredGroups = await getAllRegisteredGroups();
  logger.info({ groupCount: Object.keys(registeredGroups).length }, "State loaded");
}

async function saveState(): Promise<void> {
  await setRouterState("last_timestamp", lastTimestamp);
  await setRouterState("last_agent_timestamp", JSON.stringify(lastAgentTimestamp));
}

async function savePendingTailDrain(): Promise<void> {
  await setRouterState("pending_tail_drain", JSON.stringify(Object.fromEntries(pendingTailDrain)));
}

async function registerGroup(jid: string, group: RegisteredGroup): Promise<void> {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      "Rejecting group registration with invalid folder",
    );
    return;
  }

  registeredGroups[jid] = group;
  await setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, "logs"), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, "Group registered");
}

/**
 * Compare a DB-loaded group with a declarative group, accounting for
 * normalization differences (e.g., DB stores requiresTrigger:undefined as true,
 * isMain:false as undefined). Returns true if the group config has changed.
 */
function declarativeGroupChanged(existing: RegisteredGroup, declared: RegisteredGroup): boolean {
  if (existing.name !== declared.name) return true;
  if (existing.folder !== declared.folder) return true;
  if (existing.trigger !== declared.trigger) return true;
  // DB normalizes undefined → true for requiresTrigger
  const existingRT = existing.requiresTrigger ?? true;
  const declaredRT = declared.requiresTrigger ?? true;
  if (existingRT !== declaredRT) return true;
  // DB normalizes false/undefined → undefined for isMain
  const existingMain = existing.isMain || false;
  const declaredMain = declared.isMain || false;
  if (existingMain !== declaredMain) return true;
  // containerConfig: compare serialized form (JSON round-trip preserves structure)
  const existingCC = existing.containerConfig ? JSON.stringify(existing.containerConfig) : "";
  const declaredCC = declared.containerConfig ? JSON.stringify(declared.containerConfig) : "";
  return existingCC !== declaredCC;
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export async function getAvailableGroups(): Promise<
  import("./container-runner.js").AvailableGroup[]
> {
  const chats = await getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== "__group_sync__" && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/** @internal - exported for testing */
export function _getPendingTailDrain(): ReadonlyMap<string, { ts: string; id: string }> {
  return pendingTailDrain;
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  await initDatabase();
  logger.info("Database initialized");
  await loadState();
  syncProjectMeta();

  // Declarative group registration (for container deployments via registered-groups.json)
  for (const { jid, group } of loadDeclarativeGroups()) {
    const existing = registeredGroups[jid];
    if (!existing) {
      await registerGroup(jid, group);
    } else if (declarativeGroupChanged(existing, group)) {
      group.added_at = existing.added_at;
      await registerGroup(jid, group);
    }
  }

  const tanrenClient = createTanrenClient();
  if (tanrenClient) {
    tanrenClient
      .health()
      .then((health) => {
        logger.info(
          { version: health.version, uptime: health.uptime_seconds },
          "Tanren API connected",
        );
      })
      .catch((err) => {
        logger.warn(
          { err },
          "Tanren API health check failed — tanren integration continues (API may recover)",
        );
      });
  } else {
    logger.debug("Tanren API not configured (TANREN_API_URL / TANREN_API_KEY missing)");
  }

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(CREDENTIAL_PROXY_PORT, PROXY_BIND_HOST);

  // Start status server for external dashboards
  const statusServer = await startStatusServer(STATUS_PORT, STATUS_BIND_HOST, {
    getQueueSnapshot: () => queue.getSnapshot(),
    getChannels: () => channels.map((ch) => ({ name: ch.name, connected: ch.isConnected() })),
    getTasks: () => getAllTasks(),
    getRegisteredGroups: () => registeredGroups,
    getHealthSnapshot: () => getHealthSnapshot(),
    getRecentEvents: () => getRecentEvents(),
  });

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    proxyServer.close();
    statusServer.close();
    await queue.shutdown();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: async (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (shouldDropMessage(chatJid, cfg) && !isSenderAllowed(chatJid, msg.sender, cfg)) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              "sender-allowlist: dropping message (drop mode)",
            );
          }
          return;
        }
      }
      await storeMessage(msg);
    },
    onChatMetadata: async (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      await storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
    },
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        "Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.",
      );
      continue;
    }
    try {
      await channel.connect();
      channels.push(channel);
    } catch (err) {
      logger.fatal({ channel: channelName, err }, "Channel failed to connect");
      process.exit(1);
    }
  }
  if (channels.length === 0) {
    logger.fatal("No channels connected");
    process.exit(1);
  }

  // Start health monitor
  const healthConfig = loadHealthMonitorConfig();
  if (healthConfig.enabled) {
    const healthSources: HealthSource[] = [];
    if (tanrenClient && healthConfig.sources.tanren?.enabled) {
      healthSources.push(new TanrenHealthSource(tanrenClient));
    }
    if (healthSources.length > 0) {
      startHealthMonitor({
        sources: healthSources,
        sendEmbed: async (jid, embed) => {
          const channel = findChannel(channels, jid);
          if (!channel) {
            logger.warn({ jid }, "Health monitor: no channel owns JID");
            return;
          }
          if (channel.sendEmbed) {
            await channel.sendEmbed(jid, embed);
          } else {
            await channel.sendMessage(jid, renderEmbedAsText(embed));
          }
        },
        getState: (key) => getRouterState(`hm_${key}`),
        setState: (key, value) => setRouterState(`hm_${key}`, value),
        config: healthConfig,
      });
      logger.info({ sources: healthSources.map((s) => s.name) }, "Health monitor started");
    }
  } else {
    logger.debug("Health monitor disabled");
  }

  // Wire up group processor with injected dependencies
  const processGroupMessages = createGroupProcessor({
    registeredGroups: () => registeredGroups,
    channels: () => channels,
    lastAgentTimestamp: () => lastAgentTimestamp,
    setLastAgentTimestamp: (jid, cursor) => {
      lastAgentTimestamp[jid] = cursor;
    },
    sessions: () => sessions,
    setSession: async (folder, sessionId) => {
      sessions[folder] = sessionId;
      await setSession(folder, sessionId);
    },
    pendingTailDrain: () => pendingTailDrain,
    saveState,
    savePendingTailDrain,
    queue,
    getAllMessagesSince,
    getMessagesSince,
    getAllTasks,
    runContainerAgent,
    writeTasksSnapshot,
    writeGroupsSnapshot,
    getAvailableGroups,
    readTanrenConfig,
  });

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, "No channel owns JID, cannot send message");
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    runAgent: runContainerAgent,
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(channels.filter((ch) => ch.syncGroups).map((ch) => ch.syncGroups!(force)));
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag) => writeGroupsSnapshot(gf, im, ag),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  queue.onRetriesExhausted = async (groupJid: string) => {
    if (pendingTailDrain.delete(groupJid)) {
      await savePendingTailDrain();
      logger.info({ groupJid }, "Cleared stale pendingTailDrain after retry exhaustion");
    }
  };
  await recoverPendingMessages({
    registeredGroups: () => registeredGroups,
    lastAgentTimestamp: () => lastAgentTimestamp,
    pendingTailDrain: () => pendingTailDrain,
    queue,
    savePendingTailDrain,
    getMessagesSince,
    ASSISTANT_NAME,
  });
  startMessageLoop({
    registeredGroups: () => registeredGroups,
    channels: () => channels,
    lastAgentTimestamp: () => lastAgentTimestamp,
    setLastAgentTimestamp: (jid, cursor) => {
      lastAgentTimestamp[jid] = cursor;
    },
    pendingTailDrain: () => pendingTailDrain,
    lastTimestamp: () => lastTimestamp,
    setLastTimestamp: (ts) => {
      lastTimestamp = ts;
    },
    saveState,
    queue,
    getNewMessages,
    getMessagesSince,
  }).catch((err) => {
    logger.fatal({ err }, "Message loop crashed unexpectedly");
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, "Failed to start NanoClaw");
    process.exit(1);
  });
}
