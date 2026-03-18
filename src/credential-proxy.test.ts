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

import { startCredentialProxy } from "./credential-proxy.js";
import { recordAuthFailure } from "./auth-circuit-breaker.js";

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

describe("credential-proxy", () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
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
        path: "/v1/messages",
        headers: {
          "content-type": "application/json",
          "x-api-key": "placeholder",
        },
      },
      "{}",
    );

    expect(lastUpstreamHeaders["x-api-key"]).toBe("sk-ant-real-key");
  });

  it("OAuth mode replaces Authorization when container sends one", async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: "real-oauth-token",
    });

    await makeRequest(
      proxyPort,
      {
        method: "POST",
        path: "/api/oauth/claude_cli/create_api_key",
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
        path: "/v1/messages",
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
        path: "/v1/messages",
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
        path: "/v1/messages",
        headers: { "content-type": "application/json" },
      },
      "{}",
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe("Bad Gateway");
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
    path: "/api/oauth/claude_cli/create_api_key",
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
});
