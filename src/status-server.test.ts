import { describe, it, expect, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

import type { QueueSnapshot } from "./group-queue.js";
import type { HealthEvent, HealthStatus } from "./health-monitor.js";
import type { StatusServerDeps } from "./status-server.js";
import { startStatusServer } from "./status-server.js";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function makeRequest(
  port: number,
  options: http.RequestOptions,
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, hostname: "127.0.0.1", port }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function createMockDeps(overrides?: Partial<StatusServerDeps>): StatusServerDeps {
  return {
    getQueueSnapshot: () => ({
      activeCount: 0,
      maxConcurrent: 5,
      waitingCount: 0,
      groups: {},
    }),
    getChannels: () => [],
    getTasks: async () => [],
    getRegisteredGroups: () => ({}),
    getHealthSnapshot: () => new Map<string, HealthStatus>(),
    getRecentEvents: () => [],
    startedAt: new Date("2026-03-18T12:00:00Z"),
    ...overrides,
  };
}

describe("status-server", () => {
  let server: http.Server;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  async function start(overrides?: Partial<StatusServerDeps>): Promise<number> {
    const deps = createMockDeps(overrides);
    server = await startStatusServer(0, "127.0.0.1", deps);
    return (server.address() as AddressInfo).port;
  }

  // --- /healthz ---

  it("GET /healthz returns 200 {ok: true}", async () => {
    const port = await start();
    const res = await makeRequest(port, { method: "GET", path: "/healthz" });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("GET /healthz has correct content-type", async () => {
    const port = await start();
    const res = await makeRequest(port, { method: "GET", path: "/healthz" });

    expect(res.headers["content-type"]).toBe("application/json");
  });

  // --- /status ---

  it("GET /status returns all top-level keys", async () => {
    const port = await start();
    const res = await makeRequest(port, { method: "GET", path: "/status" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("process");
    expect(body).toHaveProperty("queue");
    expect(body).toHaveProperty("channels");
    expect(body).toHaveProperty("groups");
    expect(body).toHaveProperty("tasks");
    expect(body).toHaveProperty("health");
  });

  it("GET /status process section has expected fields", async () => {
    const port = await start();
    const res = await makeRequest(port, { method: "GET", path: "/status" });

    const { process: proc } = JSON.parse(res.body);
    expect(proc).toHaveProperty("pid");
    expect(proc).toHaveProperty("uptime_seconds");
    expect(proc).toHaveProperty("started_at");
    expect(proc).toHaveProperty("node_version");
    expect(proc).toHaveProperty("memory_mb");
    expect(typeof proc.pid).toBe("number");
    expect(typeof proc.memory_mb).toBe("number");
  });

  it("GET /status with active containers", async () => {
    const snapshot: QueueSnapshot = {
      activeCount: 2,
      maxConcurrent: 5,
      waitingCount: 1,
      groups: {
        "group1@jid": {
          active: true,
          idleWaiting: false,
          isTaskContainer: false,
          runningTaskId: null,
          pendingMessages: true,
          pendingTaskCount: 0,
          containerName: "nc-group1-abc",
          retryCount: 0,
          errorCount: 0,
          lastError: null,
          lastErrorAt: null,
        },
      },
    };

    const port = await start({ getQueueSnapshot: () => snapshot });
    const res = await makeRequest(port, { method: "GET", path: "/status" });

    const body = JSON.parse(res.body);
    expect(body.queue.activeCount).toBe(2);
    expect(body.queue.groups["group1@jid"].active).toBe(true);
  });

  it("GET /status with empty state", async () => {
    const port = await start();
    const res = await makeRequest(port, { method: "GET", path: "/status" });

    const body = JSON.parse(res.body);
    expect(body.queue.activeCount).toBe(0);
    expect(body.channels).toEqual([]);
    expect(body.groups).toEqual({});
    expect(body.tasks.total).toBe(0);
    expect(body.tasks.items).toEqual([]);
    expect(body.health).toEqual({});
  });

  it("GET /status with tasks", async () => {
    const port = await start({
      getTasks: async () => [
        {
          id: "task-1",
          group_folder: "main",
          chat_jid: "dc:123",
          prompt: "Check status",
          schedule_type: "cron" as const,
          schedule_value: "0 * * * *",
          context_mode: "group" as const,
          next_run: "2026-03-18T13:00:00Z",
          last_run: "2026-03-18T12:00:00Z",
          last_result: "OK",
          status: "active" as const,
          created_at: "2026-03-01T00:00:00Z",
        },
        {
          id: "task-2",
          group_folder: "main",
          chat_jid: "dc:123",
          prompt: "Paused task",
          schedule_type: "interval" as const,
          schedule_value: "60000",
          context_mode: "isolated" as const,
          next_run: null,
          last_run: null,
          last_result: null,
          status: "paused" as const,
          created_at: "2026-03-01T00:00:00Z",
        },
      ],
    });
    const res = await makeRequest(port, { method: "GET", path: "/status" });

    const body = JSON.parse(res.body);
    expect(body.tasks.total).toBe(2);
    expect(body.tasks.active).toBe(1);
    expect(body.tasks.paused).toBe(1);
    expect(body.tasks.items).toHaveLength(2);
    expect(body.tasks.items[0].id).toBe("task-1");
  });

  it("GET /status with health data", async () => {
    const healthMap = new Map<string, HealthStatus>();
    healthMap.set("tanren", {
      source: "tanren",
      healthy: true,
      message: "OK",
      checkedAt: new Date("2026-03-18T12:05:00Z"),
      details: { version: "1.2.3" },
    });

    const port = await start({ getHealthSnapshot: () => healthMap });
    const res = await makeRequest(port, { method: "GET", path: "/status" });

    const body = JSON.parse(res.body);
    expect(body.health.tanren).toBeDefined();
    expect(body.health.tanren.healthy).toBe(true);
    expect(body.health.tanren.checked_at).toBe("2026-03-18T12:05:00.000Z");
    expect(body.health.tanren.details).toEqual({ version: "1.2.3" });
  });

  // --- /events ---

  it("GET /events returns empty array", async () => {
    const port = await start();
    const res = await makeRequest(port, { method: "GET", path: "/events" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toEqual({ events: [], count: 0 });
  });

  it("GET /events returns populated events", async () => {
    const events: HealthEvent[] = [
      {
        source: "tanren",
        type: "phase_completed",
        timestamp: "2026-03-18T12:00:00Z",
        title: "Phase completed",
        data: { phase: "do-task" },
      },
    ];

    const port = await start({ getRecentEvents: () => events });
    const res = await makeRequest(port, { method: "GET", path: "/events" });

    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.events[0].source).toBe("tanren");
    expect(body.events[0].type).toBe("phase_completed");
  });

  // --- Error cases ---

  it("unknown path returns 404", async () => {
    const port = await start();
    const res = await makeRequest(port, { method: "GET", path: "/unknown" });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
  });

  it("POST returns 405", async () => {
    const port = await start();
    const res = await makeRequest(port, { method: "POST", path: "/healthz" });

    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: "Method not allowed" });
  });

  it("server starts and closes cleanly", async () => {
    const port = await start();
    const res = await makeRequest(port, { method: "GET", path: "/healthz" });
    expect(res.statusCode).toBe(200);

    await new Promise<void>((r) => server.close(() => r()));
    // Re-assign so afterEach doesn't double-close
    server = undefined as unknown as http.Server;
  });

  it("handles getTasks() rejection gracefully", async () => {
    const port = await start({
      getTasks: async () => {
        throw new Error("DB connection lost");
      },
    });
    const res = await makeRequest(port, { method: "GET", path: "/status" });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Internal server error" });
  });
});
