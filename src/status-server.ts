import { createServer, Server } from "http";

import type { QueueSnapshot } from "./group-queue.js";
import type { HealthEvent, HealthStatus } from "./health-monitor.js";
import type { RegisteredGroup, ScheduledTask } from "./types.js";
import { logger } from "./logger.js";

export interface StatusServerDeps {
  getQueueSnapshot: () => QueueSnapshot;
  getChannels: () => Array<{ name: string; connected: boolean }>;
  getTasks: () => Promise<ScheduledTask[]>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getHealthSnapshot: () => ReadonlyMap<string, HealthStatus>;
  getRecentEvents: () => readonly HealthEvent[];
}

function jsonResponse(res: import("http").ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function buildHealthSection(snapshot: ReadonlyMap<string, HealthStatus>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, status] of snapshot) {
    result[name] = {
      healthy: status.healthy,
      message: status.message,
      checked_at: status.checkedAt.toISOString(),
      details: status.details ?? null,
    };
  }
  return result;
}

function buildTasksSection(tasks: ScheduledTask[]): Record<string, unknown> {
  const active = tasks.filter((t) => t.status === "active").length;
  const paused = tasks.filter((t) => t.status === "paused").length;
  return {
    total: tasks.length,
    active,
    paused,
    items: tasks.map((t) => ({
      id: t.id,
      group_folder: t.group_folder,
      prompt: t.prompt.slice(0, 200),
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      next_run: t.next_run,
      last_run: t.last_run,
      last_result: t.last_result,
      status: t.status,
    })),
  };
}

function buildGroupsSection(groups: Record<string, RegisteredGroup>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [jid, group] of Object.entries(groups)) {
    result[jid] = {
      name: group.name,
      folder: group.folder,
      is_main: group.isMain === true,
    };
  }
  return result;
}

export function startStatusServer(
  port: number,
  host: string,
  deps: StatusServerDeps,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== "GET") {
        jsonResponse(res, 405, { error: "Method not allowed" });
        return;
      }

      const pathname = (req.url || "/").split("?")[0];

      if (pathname === "/healthz") {
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (pathname === "/events") {
        const events = deps.getRecentEvents().map((e) => ({
          source: e.source,
          type: e.type,
          timestamp: e.timestamp,
          title: e.title,
          data: e.data,
        }));
        jsonResponse(res, 200, { events, count: events.length });
        return;
      }

      if (pathname === "/status") {
        handleStatus(deps, res);
        return;
      }

      jsonResponse(res, 404, { error: "Not found" });
    });

    server.listen(port, host, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      logger.info({ port: boundPort, host }, "Status server started");
      resolve(server);
    });

    server.on("error", reject);
  });
}

async function handleStatus(deps: StatusServerDeps, res: import("http").ServerResponse) {
  try {
    const tasks = await deps.getTasks();
    const mem = process.memoryUsage();
    const uptimeSeconds = Math.floor(process.uptime());
    const startedAt = new Date(Date.now() - uptimeSeconds * 1000);

    const body = {
      timestamp: new Date().toISOString(),
      process: {
        pid: process.pid,
        uptime_seconds: uptimeSeconds,
        started_at: startedAt.toISOString(),
        node_version: process.version,
        memory_mb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      },
      queue: deps.getQueueSnapshot(),
      channels: deps.getChannels(),
      groups: buildGroupsSection(deps.getRegisteredGroups()),
      tasks: buildTasksSection(tasks),
      health: buildHealthSection(deps.getHealthSnapshot()),
    };

    jsonResponse(res, 200, body);
  } catch (err) {
    logger.error({ err }, "Status server: error building status response");
    jsonResponse(res, 500, { error: "Internal server error" });
  }
}
