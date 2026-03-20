import type { DiscordEmbed } from "./types.js";
import type { HealthMonitorConfig } from "./health-monitor-config.js";
import { resolveJids } from "./health-monitor-config.js";
import {
  formatEventEmbed,
  formatHealthStatusEmbed,
  formatMonitorErrorEmbed,
} from "./health-embeds.js";
import { logger } from "./logger.js";

export interface HealthStatus {
  source: string;
  healthy: boolean;
  message: string;
  details?: Record<string, unknown>;
  checkedAt: Date;
}

export interface HealthEvent {
  source: string;
  type: string;
  timestamp: string;
  title: string;
  data: Record<string, unknown>;
}

export interface HealthSource {
  name: string;
  checkHealth(): Promise<HealthStatus | null>;
  fetchEvents(cursor: string | null): Promise<{ events: HealthEvent[]; cursor: string | null }>;
}

export interface HealthMonitorDeps {
  sources: HealthSource[];
  sendEmbed: (jid: string, embed: DiscordEmbed) => Promise<void>;
  getState: (key: string) => Promise<string | undefined>;
  setState: (key: string, value: string) => Promise<void>;
  config: HealthMonitorConfig;
}

let monitorRunning = false;

const cachedHealthStatus = new Map<string, HealthStatus>();
const MAX_RECENT_EVENTS = 100;
const recentEvents: HealthEvent[] = [];

export function getHealthSnapshot(): ReadonlyMap<string, HealthStatus> {
  return cachedHealthStatus;
}

export function getRecentEvents(): readonly HealthEvent[] {
  return recentEvents;
}

export function startHealthMonitor(deps: HealthMonitorDeps): void {
  if (monitorRunning) {
    logger.debug("Health monitor already running, skipping duplicate start");
    return;
  }
  monitorRunning = true;

  const lastHealthState = new Map<string, boolean>();

  const init = async () => {
    // Initialize from persisted state
    for (const source of deps.sources) {
      const persisted = await deps.getState(`health_status_${source.name}`);
      if (persisted !== undefined) {
        lastHealthState.set(source.name, persisted === "true");
      }
    }
  };

  const poll = async () => {
    for (const source of deps.sources) {
      await pollSource(source, deps, lastHealthState);
    }

    if (monitorRunning) {
      setTimeout(poll, deps.config.pollIntervalMs);
    }
  };

  // Init then start polling — errors are caught to prevent unhandled rejections
  init()
    .then(() => setTimeout(poll, 0))
    .catch((err) => {
      logger.error(
        { err, sources: deps.sources.map((s) => s.name) },
        "Health monitor: failed to initialize persisted state, starting with empty state",
      );
      setTimeout(poll, 0);
    });
}

async function pollSource(
  source: HealthSource,
  deps: HealthMonitorDeps,
  lastHealthState: Map<string, boolean>,
): Promise<void> {
  // Health check
  try {
    const status = await source.checkHealth();
    if (status) {
      cachedHealthStatus.set(source.name, status);
      const previous = lastHealthState.get(source.name) ?? null;

      // Only post on state transitions or first-check-unhealthy
      const shouldPost = previous !== null ? previous !== status.healthy : !status.healthy;

      if (shouldPost) {
        const embed = formatHealthStatusEmbed(status, previous);
        const jids = resolveJids(deps.config, "health_status", source.name);
        let anySendSucceeded = false;
        for (const jid of jids) {
          try {
            await deps.sendEmbed(jid, embed);
            anySendSucceeded = true;
          } catch (err) {
            logger.error({ jid, source: source.name, err }, "Health monitor: sendEmbed failed");
          }
        }
        // Only commit new state if delivery succeeded (or no JIDs to send to).
        // If all sends failed, keep previous state so the transition retries next poll.
        if (anySendSucceeded || jids.length === 0) {
          lastHealthState.set(source.name, status.healthy);
          await deps.setState(`health_status_${source.name}`, String(status.healthy));
        }
      } else {
        // No transition — still commit current state (idempotent, no notification needed)
        lastHealthState.set(source.name, status.healthy);
        await deps.setState(`health_status_${source.name}`, String(status.healthy));
      }
    }
  } catch (err) {
    logger.error({ source: source.name, err }, "Health monitor: checkHealth threw");
    cachedHealthStatus.set(source.name, {
      source: source.name,
      healthy: false,
      message: err instanceof Error ? err.message : String(err),
      checkedAt: new Date(),
    });
    await sendErrorEmbed(deps, source.name, "Health check error", err);
  }

  // Event polling
  try {
    const cursorKey = `events_cursor_${source.name}`;
    const rawCursor = (await deps.getState(cursorKey)) ?? null;
    const { events, cursor: newCursor } = await source.fetchEvents(rawCursor);

    // On first run (rawCursor was null), skip posting — cursor was just initialized.
    // Commit cursor immediately since there's nothing to deliver.
    if (rawCursor === null) {
      if (newCursor !== null) {
        await deps.setState(cursorKey, newCursor);
      }
    } else {
      let allDelivered = true;
      const deliveredEvents: HealthEvent[] = [];
      for (const event of events) {
        const embed = formatEventEmbed(event);
        const jids = resolveJids(deps.config, event.type, source.name);
        let eventDelivered = jids.length === 0;
        for (const jid of jids) {
          try {
            await deps.sendEmbed(jid, embed);
            eventDelivered = true;
          } catch (err) {
            logger.error(
              { jid, source: source.name, eventType: event.type, err },
              "Health monitor: sendEmbed failed for event",
            );
          }
        }
        if (eventDelivered) {
          deliveredEvents.push(event);
        } else {
          allDelivered = false;
        }
      }
      // Only advance cursor and cache events after all deliveries succeed.
      // If any event failed all sends, keep old cursor to retry next poll —
      // caching before commit would produce duplicates on the retry.
      if (allDelivered && newCursor !== null) {
        await deps.setState(cursorKey, newCursor);
        for (const event of deliveredEvents) {
          recentEvents.push(event);
          if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.shift();
        }
      }
    }
  } catch (err) {
    logger.error({ source: source.name, err }, "Health monitor: fetchEvents threw");
    await sendErrorEmbed(deps, source.name, "Event fetch error", err);
  }
}

async function sendErrorEmbed(
  deps: HealthMonitorDeps,
  sourceName: string,
  context: string,
  err: unknown,
): Promise<void> {
  const embed = formatMonitorErrorEmbed(sourceName, context, err);
  const jids = resolveJids(deps.config, "monitor_error", sourceName);
  for (const jid of jids) {
    try {
      await deps.sendEmbed(jid, embed);
    } catch (sendErr) {
      logger.error({ jid, sourceName, sendErr }, "Health monitor: failed to send error embed");
    }
  }
}

/** @internal - for tests only. */
export function _resetHealthMonitorForTests(): void {
  monitorRunning = false;
  cachedHealthStatus.clear();
  recentEvents.length = 0;
}
