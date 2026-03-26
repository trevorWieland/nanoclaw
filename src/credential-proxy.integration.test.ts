import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import http from "http";
import type { AddressInfo } from "net";

// --- Mocks ---
// Only mock env and logger. Auth circuit breaker is REAL for integration tests.

vi.mock("./env.js", () => ({
  readEnvFile: vi.fn(() => ({
    ANTHROPIC_API_KEY: "sk-real-key-123",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_BASE_URL: "",
  })),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  startCredentialProxy,
  registerContainerToken,
  deregisterContainerToken,
  _resetTokenRegistryForTests,
  RATE_LIMIT_MAX_REQUESTS,
} from "./credential-proxy.js";
import {
  recordAuthFailure,
  recordAuthSuccess,
  checkCircuit,
  _resetAuthCircuitBreakerForTests,
} from "./auth-circuit-breaker.js";
import { readEnvFile } from "./env.js";
import { logger } from "./logger.js";

// --- Helpers ---

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = "",
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
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
    req.write(body);
    req.end();
  });
}

function tokenPath(path: string, token: string): string {
  return `/proxy/${token}${path}`;
}

// --- Integration tests ---

describe("credential-proxy integration", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let upstreamRequests: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>;

  let proxyServer: http.Server;
  let proxyPort: number;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        upstreamRequests.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  beforeEach(() => {
    _resetTokenRegistryForTests();
    _resetAuthCircuitBreakerForTests();
    upstreamRequests = [];
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();

    // Default env mock: API-key mode pointing at our upstream
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: "sk-real-key-123",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
  });

  afterEach(async () => {
    _resetTokenRegistryForTests();
    _resetAuthCircuitBreakerForTests();
    if (proxyServer) {
      await new Promise<void>((r) => proxyServer.close(() => r()));
    }
  });

  async function startProxy(): Promise<number> {
    proxyServer = await startCredentialProxy(0, "127.0.0.1");
    return (proxyServer.address() as AddressInfo).port;
  }

  it("full API-key lifecycle: register → request → deregister → reject", async () => {
    const token = "lifecycle-token-001";
    const container = "nanoclaw-lifecycle-1";
    registerContainerToken(container, token);

    proxyPort = await startProxy();

    // Send request through proxy
    const res1 = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages", token),
        headers: {
          "content-type": "application/json",
          "x-api-key": "placeholder-from-container",
        },
      },
      '{"model":"claude"}',
    );

    expect(res1.statusCode).toBe(200);
    expect(upstreamRequests).toHaveLength(1);

    // Upstream must receive the real API key, not the container placeholder
    expect(upstreamRequests[0].headers["x-api-key"]).toBe("sk-real-key-123");
    // Proxy token must never leak to upstream
    expect(upstreamRequests[0].url).not.toContain(token);
    expect(JSON.stringify(upstreamRequests[0].headers)).not.toContain(token);

    // Deregister the container token
    deregisterContainerToken(container);

    // Next request with same token should be rejected
    const res2 = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages", token),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );

    expect(res2.statusCode).toBe(403);
    expect(res2.body).toBe("invalid_token");
    // Upstream must not have received a second request
    expect(upstreamRequests).toHaveLength(1);
  });

  it("OAuth mode injects Authorization header on exchange requests", async () => {
    // Configure env mock for OAuth mode (no API key, has OAuth token)
    vi.mocked(readEnvFile).mockReturnValue({
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-secret-456",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });

    const token = "oauth-token-002";
    registerContainerToken("nanoclaw-oauth-1", token);

    // Need a separate proxy instance with OAuth config
    const oauthProxy = await startCredentialProxy(0, "127.0.0.1");
    const oauthProxyPort = (oauthProxy.address() as AddressInfo).port;

    try {
      const res = await makeRequest(
        oauthProxyPort,
        {
          method: "POST",
          path: tokenPath("/api/oauth/claude_cli/create_api_key", token),
          headers: {
            "content-type": "application/json",
            authorization: "Bearer placeholder-from-container",
          },
        },
        "{}",
      );

      expect(res.statusCode).toBe(200);
      expect(upstreamRequests).toHaveLength(1);

      // Upstream must receive the real OAuth token, not the placeholder
      expect(upstreamRequests[0].headers["authorization"]).toBe("Bearer real-oauth-secret-456");
    } finally {
      await new Promise<void>((r) => oauthProxy.close(() => r()));
    }
  });

  it("circuit breaker blocks after 3 failures, resets after timeout", () => {
    vi.useFakeTimers();

    try {
      // Initially the circuit is closed (allowed)
      expect(checkCircuit().allowed).toBe(true);

      // Record 3 consecutive auth failures
      recordAuthFailure();
      recordAuthFailure();
      recordAuthFailure();

      // Circuit should now be open (blocked)
      const blocked = checkCircuit();
      expect(blocked.allowed).toBe(false);

      // Advance time by 15 minutes (the reset timeout)
      vi.advanceTimersByTime(15 * 60 * 1000);

      // Circuit should auto-reset
      const reset = checkCircuit();
      expect(reset.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rate limit on one container does not affect another", async () => {
    const tokenA = "ratelimit-token-A";
    const tokenB = "ratelimit-token-B";
    registerContainerToken("nanoclaw-container-A", tokenA);
    registerContainerToken("nanoclaw-container-B", tokenB);

    proxyPort = await startProxy();

    // Exhaust rate limit on container A
    const batchSize = 20;
    for (let batch = 0; batch < RATE_LIMIT_MAX_REQUESTS / batchSize; batch++) {
      const promises = [];
      for (let i = 0; i < batchSize; i++) {
        promises.push(
          makeRequest(
            proxyPort,
            {
              method: "POST",
              path: tokenPath("/v1/messages", tokenA),
              headers: { "content-type": "application/json" },
            },
            "{}",
          ),
        );
      }
      await Promise.all(promises);
    }

    // Container A should now be rate limited
    const resA = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages", tokenA),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(resA.statusCode).toBe(429);

    // Container B should still be able to send requests
    const resB = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages", tokenB),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(resB.statusCode).toBe(200);
  });

  it("encoded-slash path traversal blocked, never reaches upstream", async () => {
    const token = "traversal-token-003";
    registerContainerToken("nanoclaw-traversal-1", token);

    proxyPort = await startProxy();
    const beforeCount = upstreamRequests.length;

    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/..%2f..%2fetc/passwd", token),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );

    expect(res.statusCode).toBe(400);
    // The upstream must never have received this request
    expect(upstreamRequests.length).toBe(beforeCount);
  });

  it("concurrent requests from multiple containers get correct credentials", async () => {
    const containers = [
      { name: "nanoclaw-concurrent-1", token: "concurrent-token-1" },
      { name: "nanoclaw-concurrent-2", token: "concurrent-token-2" },
      { name: "nanoclaw-concurrent-3", token: "concurrent-token-3" },
    ];

    for (const c of containers) {
      registerContainerToken(c.name, c.token);
    }

    proxyPort = await startProxy();
    vi.mocked(logger.info).mockClear();

    // Send all 3 requests concurrently
    const results = await Promise.all(
      containers.map((c) =>
        makeRequest(
          proxyPort,
          {
            method: "POST",
            path: tokenPath("/v1/messages", c.token),
            headers: { "content-type": "application/json" },
          },
          JSON.stringify({ container: c.name }),
        ),
      ),
    );

    // All should succeed
    for (const res of results) {
      expect(res.statusCode).toBe(200);
    }

    // Upstream should have received exactly 3 requests
    expect(upstreamRequests).toHaveLength(3);

    // Each upstream request must carry the correct API key
    for (const upReq of upstreamRequests) {
      expect(upReq.headers["x-api-key"]).toBe("sk-real-key-123");
    }

    // Audit log should have 3 credential_proxy_request events
    const auditEvents = vi
      .mocked(logger.info)
      .mock.calls.filter(
        (call) =>
          typeof call[0] === "object" &&
          (call[0] as Record<string, unknown>).event === "credential_proxy_request",
      );
    expect(auditEvents).toHaveLength(3);

    // Each audit event should reference one of our containers
    const loggedContainers = auditEvents.map(
      (call) => (call[0] as Record<string, unknown>).container,
    );
    for (const c of containers) {
      expect(loggedContainers).toContain(c.name);
    }
  });
});
