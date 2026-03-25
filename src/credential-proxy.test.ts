import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "http";
import { mkdir, writeFile, readFile } from "fs/promises";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import nodePath from "path";
import type { AddressInfo } from "net";

const mockEnv: Record<string, string> = {};
vi.mock("./env.js", () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("./auth-circuit-breaker.js", () => ({
  checkCircuit: vi.fn(() => ({ allowed: true })),
  recordAuthFailure: vi.fn(),
}));

import {
  startCredentialProxy,
  registerContainerToken,
  deregisterContainerToken,
  _resetTokenRegistryForTests,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  MAX_BODY_SIZE,
} from "./credential-proxy.js";
import { recordAuthFailure } from "./auth-circuit-breaker.js";
import { logger } from "./logger.js";

const TEST_TOKEN = "test-token-abc123";
const TEST_CONTAINER = "nanoclaw-test-1234";

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = "",
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
    req.write(body);
    req.end();
  });
}

/** Build a path with the proxy token prefix */
function tokenPath(path: string, token = TEST_TOKEN): string {
  return `/proxy/${token}${path}`;
}

describe("credential-proxy", () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let lastUpstreamPath: string;

  beforeEach(async () => {
    _resetTokenRegistryForTests();
    registerContainerToken(TEST_CONTAINER, TEST_TOKEN);
    lastUpstreamHeaders = {};
    lastUpstreamPath = "";

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    _resetTokenRegistryForTests();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it("API-key mode injects x-api-key and strips placeholder", async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: "sk-ant-real-key" });

    await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: {
          "content-type": "application/json",
          "x-api-key": "placeholder",
        },
      },
      "{}",
    );

    expect(lastUpstreamHeaders["x-api-key"]).toBe("sk-ant-real-key");
  });

  it("forwards stripped path (without proxy prefix) to upstream", async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: "sk-ant-real-key" });

    await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: {
          "content-type": "application/json",
        },
      },
      "{}",
    );

    expect(lastUpstreamPath).toBe("/v1/messages");
  });

  it("OAuth mode replaces Authorization when container sends one", async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-token",
    });

    await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/api/oauth/claude_cli/create_api_key"),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer placeholder",
        },
      },
      "{}",
    );

    expect(lastUpstreamHeaders["authorization"]).toBe("Bearer real-oauth-token");
  });

  it("OAuth mode does not inject Authorization when container omits it", async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-token",
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: {
          "content-type": "application/json",
          "x-api-key": "temp-key-from-exchange",
        },
      },
      "{}",
    );

    expect(lastUpstreamHeaders["x-api-key"]).toBe("temp-key-from-exchange");
    expect(lastUpstreamHeaders["authorization"]).toBeUndefined();
  });

  it("strips hop-by-hop headers", async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: "sk-ant-real-key" });

    await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: {
          "content-type": "application/json",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
        },
      },
      "{}",
    );

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders["keep-alive"]).toBeUndefined();
    expect(lastUpstreamHeaders["transfer-encoding"]).toBeUndefined();
  });

  it("returns 502 when upstream is unreachable", async () => {
    registerContainerToken(TEST_CONTAINER, TEST_TOKEN);
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: "sk-ant-real-key",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:59999",
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe("Bad Gateway");
  });
});

describe("token authentication", () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;

  beforeEach(async () => {
    _resetTokenRegistryForTests();
    registerContainerToken(TEST_CONTAINER, TEST_TOKEN);

    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: "sk-ant-real-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    _resetTokenRegistryForTests();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  it("accepts request with valid token", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects request with invalid token", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages", "wrong-token"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("invalid_token");
  });

  it("rejects request with no proxy prefix", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: "/v1/messages",
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe("invalid_token");
  });

  it("rejects request after token is deregistered", async () => {
    deregisterContainerToken(TEST_CONTAINER);

    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(403);
  });

  it("rejects malformed proxy prefix (no trailing path)", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: `/proxy/${TEST_TOKEN}`,
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(403);
  });
});

describe("path validation", () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;

  beforeEach(async () => {
    _resetTokenRegistryForTests();
    registerContainerToken(TEST_CONTAINER, TEST_TOKEN);

    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: "sk-ant-real-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    _resetTokenRegistryForTests();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  it("allows /v1/messages", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(200);
  });

  it("allows /api/oauth/claude_cli/create_api_key", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/api/oauth/claude_cli/create_api_key"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects /etc/passwd", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/etc/passwd"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("bad_path");
  });

  it("rejects path traversal", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/../etc/passwd"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("bad_path");
  });
});

describe("request validation", () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;

  beforeEach(async () => {
    _resetTokenRegistryForTests();
    registerContainerToken(TEST_CONTAINER, TEST_TOKEN);

    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: "sk-ant-real-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    _resetTokenRegistryForTests();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  it("rejects GET requests", async () => {
    const res = await makeRequest(proxyPort, {
      method: "GET",
      path: tokenPath("/v1/messages"),
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(405);
    expect(res.body).toBe("method_not_allowed");
  });

  it("rejects unsupported content-type", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: { "content-type": "text/plain" },
      },
      "hello",
    );
    expect(res.statusCode).toBe(415);
    expect(res.body).toBe("unsupported_content_type");
  });

  it("allows application/x-www-form-urlencoded (OAuth exchange)", async () => {
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/api/oauth/claude_cli/create_api_key"),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      "grant_type=client_credentials",
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects Content-Length exceeding MAX_BODY_SIZE", async () => {
    const res = await makeRequest(proxyPort, {
      method: "POST",
      path: tokenPath("/v1/messages"),
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_BODY_SIZE + 1),
      },
    });
    expect(res.statusCode).toBe(413);
    expect(res.body).toBe("body_too_large");
  });
});

describe("rate limiting", () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;

  beforeEach(async () => {
    _resetTokenRegistryForTests();
    registerContainerToken(TEST_CONTAINER, TEST_TOKEN);

    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: "sk-ant-real-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    _resetTokenRegistryForTests();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  it("allows requests under the rate limit", async () => {
    // Send a few requests — should all succeed
    for (let i = 0; i < 5; i++) {
      const res = await makeRequest(
        proxyPort,
        {
          method: "POST",
          path: tokenPath("/v1/messages"),
          headers: { "content-type": "application/json" },
        },
        "{}",
      );
      expect(res.statusCode).toBe(200);
    }
  });

  it("rejects requests exceeding the rate limit", async () => {
    // Exhaust the rate limit
    const requests = [];
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      requests.push(
        makeRequest(
          proxyPort,
          {
            method: "POST",
            path: tokenPath("/v1/messages"),
            headers: { "content-type": "application/json" },
          },
          "{}",
        ),
      );
    }
    await Promise.all(requests);

    // Next request should be rate limited
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(429);
    expect(res.body).toBe("rate_limited");
  });

  it("different containers have independent rate limits", async () => {
    const otherToken = "other-token-xyz";
    const otherContainer = "nanoclaw-other-5678";
    registerContainerToken(otherContainer, otherToken);

    // Exhaust rate limit for TEST_CONTAINER
    const requests = [];
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      requests.push(
        makeRequest(
          proxyPort,
          {
            method: "POST",
            path: tokenPath("/v1/messages"),
            headers: { "content-type": "application/json" },
          },
          "{}",
        ),
      );
    }
    await Promise.all(requests);

    // Other container should still be allowed
    const res = await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages", otherToken),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );
    expect(res.statusCode).toBe(200);
  });
});

describe("audit logging", () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;

  beforeEach(async () => {
    _resetTokenRegistryForTests();
    registerContainerToken(TEST_CONTAINER, TEST_TOKEN);
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.warn).mockClear();

    upstreamServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstreamServer.address() as AddressInfo).port;

    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: "sk-ant-real-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    _resetTokenRegistryForTests();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  it("logs credential_proxy_request on successful forward", async () => {
    await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );

    const infoCalls = vi.mocked(logger.info).mock.calls;
    const auditCall = infoCalls.find(
      (call) =>
        typeof call[0] === "object" && (call[0] as any).event === "credential_proxy_request",
    );
    expect(auditCall).toBeDefined();
    const data = auditCall![0] as Record<string, unknown>;
    expect(data.container).toBe(TEST_CONTAINER);
    expect(data.path).toBe("/v1/messages");
    expect(data.authMode).toBe("api-key");
  });

  it("logs credential_proxy_rejected on invalid token", async () => {
    await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: tokenPath("/v1/messages", "bad-token"),
        headers: { "content-type": "application/json" },
      },
      "{}",
    );

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const rejectCall = warnCalls.find(
      (call) =>
        typeof call[0] === "object" && (call[0] as any).event === "credential_proxy_rejected",
    );
    expect(rejectCall).toBeDefined();
    const data = rejectCall![0] as Record<string, unknown>;
    expect(data.reason).toBe("invalid_token");
  });

  it("logs credential_proxy_register on token registration", async () => {
    vi.mocked(logger.info).mockClear();
    registerContainerToken("new-container", "new-token");

    const infoCalls = vi.mocked(logger.info).mock.calls;
    const registerCall = infoCalls.find(
      (call) =>
        typeof call[0] === "object" && (call[0] as any).event === "credential_proxy_register",
    );
    expect(registerCall).toBeDefined();
    expect((registerCall![0] as any).container).toBe("new-container");
  });

  it("logs credential_proxy_deregister on token deregistration", async () => {
    vi.mocked(logger.info).mockClear();
    deregisterContainerToken(TEST_CONTAINER);

    const infoCalls = vi.mocked(logger.info).mock.calls;
    const deregisterCall = infoCalls.find(
      (call) =>
        typeof call[0] === "object" && (call[0] as any).event === "credential_proxy_deregister",
    );
    expect(deregisterCall).toBeDefined();
    expect((deregisterCall![0] as any).container).toBe(TEST_CONTAINER);
  });
});

describe("OAuth token refresh", () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;
  let tmpDir: string;
  let savedHome: string | undefined;
  let credentialsPath: string;

  const expiredCreds = {
    claudeAiOauth: {
      accessToken: "expired-token",
      refreshToken: "refresh-token-123",
      expiresAt: Date.now() - 3600_000, // 1 hour ago
    },
  };

  async function setupCredentials(creds = expiredCreds): Promise<void> {
    const claudeDir = nodePath.join(tmpDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    credentialsPath = nodePath.join(claudeDir, ".credentials.json");
    await writeFile(credentialsPath, JSON.stringify(creds, null, 2));
  }

  beforeEach(async () => {
    _resetTokenRegistryForTests();
    registerContainerToken(TEST_CONTAINER, TEST_TOKEN);
    savedHome = process.env.HOME;
    tmpDir = await mkdtemp(nodePath.join(tmpdir(), "cred-proxy-test-"));
    process.env.HOME = tmpDir;

    lastUpstreamHeaders = {};
    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    vi.mocked(recordAuthFailure).mockClear();
  });

  afterEach(async () => {
    _resetTokenRegistryForTests();
    process.env.HOME = savedHome;
    vi.unstubAllGlobals();
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startOAuthProxy(): Promise<number> {
    // OAuth mode: no API key, no env OAuth token — falls through to credentials file
    Object.assign(mockEnv, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  const oauthRequest = {
    method: "POST",
    path: tokenPath("/api/oauth/claude_cli/create_api_key"),
    headers: {
      "content-type": "application/json",
      authorization: "Bearer placeholder",
    },
  };

  it("refreshes expired token and injects the new one", async () => {
    await setupCredentials();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ access_token: "new-token", expires_in: 3600 })),
        ),
      ),
    );

    proxyPort = await startOAuthProxy();
    const res = await makeRequest(proxyPort, oauthRequest, "{}");

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders["authorization"]).toBe("Bearer new-token");

    // Verify credentials file was updated
    const updated = JSON.parse(await readFile(credentialsPath, "utf-8"));
    expect(updated.claudeAiOauth.accessToken).toBe("new-token");
  });

  it("falls back to expired token on timeout (AbortError)", async () => {
    await setupCredentials();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new DOMException("The operation was aborted", "AbortError"))),
    );

    proxyPort = await startOAuthProxy();
    const res = await makeRequest(proxyPort, oauthRequest, "{}");

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders["authorization"]).toBe("Bearer expired-token");
    expect(recordAuthFailure).toHaveBeenCalled();
  });

  it("retries on 5xx then succeeds", async () => {
    await setupCredentials();
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(new Response("Server Error", { status: 503 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ access_token: "retried-token" })));
      }),
    );

    proxyPort = await startOAuthProxy();
    const res = await makeRequest(proxyPort, oauthRequest, "{}");

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders["authorization"]).toBe("Bearer retried-token");
    expect(callCount).toBe(2);
  }, 15_000);

  it("does not retry on non-retryable error (400)", async () => {
    await setupCredentials();
    const mockFetch = vi.fn(() => Promise.resolve(new Response("Bad Request", { status: 400 })));
    vi.stubGlobal("fetch", mockFetch);

    proxyPort = await startOAuthProxy();
    const res = await makeRequest(proxyPort, oauthRequest, "{}");

    expect(res.statusCode).toBe(200);
    expect(lastUpstreamHeaders["authorization"]).toBe("Bearer expired-token");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(recordAuthFailure).toHaveBeenCalled();
  });

  it("deduplicates concurrent refresh calls", async () => {
    await setupCredentials();

    let resolveFetch: ((res: Response) => void) | undefined;
    const mockFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", mockFetch);

    proxyPort = await startOAuthProxy();

    // Fire two requests concurrently
    const p1 = makeRequest(proxyPort, oauthRequest, "{}");
    const p2 = makeRequest(proxyPort, oauthRequest, "{}");

    // Wait for both to reach the refresh call
    await new Promise((r) => setTimeout(r, 100));

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Resolve the single fetch — both requests should get the token
    resolveFetch!(new Response(JSON.stringify({ access_token: "dedup-token", expires_in: 3600 })));

    const [res1, res2] = await Promise.all([p1, p2]);
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
  });

  it("records auth failure only once for deduplicated failed refresh", async () => {
    await setupCredentials();

    let rejectFetch: ((err: Error) => void) | undefined;
    const mockFetch = vi.fn(
      () =>
        new Promise<Response>((_, reject) => {
          rejectFetch = reject;
        }),
    );
    vi.stubGlobal("fetch", mockFetch);

    proxyPort = await startOAuthProxy();

    // Fire three requests concurrently — enough to trip MAX_FAILURES if counted per-waiter
    const p1 = makeRequest(proxyPort, oauthRequest, "{}");
    const p2 = makeRequest(proxyPort, oauthRequest, "{}");
    const p3 = makeRequest(proxyPort, oauthRequest, "{}");

    await new Promise((r) => setTimeout(r, 100));

    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Reject the single fetch — all three waiters get the failure
    rejectFetch!(new DOMException("The operation was aborted", "AbortError"));

    await Promise.all([p1, p2, p3]);

    // Only the owner should record the failure, not all three waiters
    expect(recordAuthFailure).toHaveBeenCalledTimes(1);
  });
});
