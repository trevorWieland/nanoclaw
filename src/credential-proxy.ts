/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Security hardening:
 * - Per-container token authentication (URL-embedded: /proxy/<token>/...)
 * - Request validation (path allowlist, method, content-type, body size)
 * - Per-container rate limiting (sliding window)
 * - Structured audit logging for every credential injection and rejection
 *
 * Docs map:
 * - docs/SECURITY.md#5-credential-isolation-credential-proxy
 * - docs/SPEC.md#claude-authentication
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * OAuth token sources (checked in order):
 *   1. .env CLAUDE_CODE_OAUTH_TOKEN (long-lived, from `claude setup-token`)
 *   2. ~/.claude/.credentials.json (short-lived, from `/login`)
 *      — auto-refreshed when expired/expiring via OAuth2 refresh_token grant
 */
import { readFile, rename, writeFile } from "fs/promises";
import { createServer, Server } from "http";
import { request as httpsRequest } from "https";
import { request as httpRequest, RequestOptions } from "http";
import path from "path";

import { checkCircuit, recordAuthFailure } from "./auth-circuit-breaker.js";
import { readEnvFile } from "./env.js";
import { logger } from "./logger.js";

type AuthMode = "api-key" | "oauth";

const REFRESH_TIMEOUT_MS = 10_000;
const REFRESH_MAX_RETRIES = 2;
const REFRESH_BASE_DELAY_MS = 1_000;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

// --- Token registry ---
// Maps token → containerName for O(1) lookup on each request.
// A reverse map (containerName → token) enables deregistration by name.
const tokenToContainer = new Map<string, string>();
const containerToToken = new Map<string, string>();

/** Register a per-container proxy token. Called before spawning. */
export function registerContainerToken(containerName: string, token: string): void {
  // Remove any prior token for this container to prevent orphaned valid tokens
  const existingToken = containerToToken.get(containerName);
  if (existingToken && existingToken !== token) {
    tokenToContainer.delete(existingToken);
  }
  tokenToContainer.set(token, containerName);
  containerToToken.set(containerName, token);
  logger.info(
    { event: "credential_proxy_register", container: containerName },
    "Container token registered",
  );
}

/** Deregister a container token. Called on container close/error. */
export function deregisterContainerToken(containerName: string): void {
  const token = containerToToken.get(containerName);
  if (token) {
    tokenToContainer.delete(token);
    rateLimits.delete(containerName);
  }
  containerToToken.delete(containerName);
  logger.info(
    { event: "credential_proxy_deregister", container: containerName },
    "Container token deregistered",
  );
}

/** @internal — for tests only. */
export function _resetTokenRegistryForTests(): void {
  tokenToContainer.clear();
  containerToToken.clear();
  rateLimits.clear();
}

// --- Rate limiting ---
// Sliding window: track request timestamps per container name.
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_REQUESTS = 120;

const rateLimits = new Map<string, number[]>();

function checkRateLimit(containerName: string): boolean {
  const now = Date.now();
  let timestamps = rateLimits.get(containerName);
  if (!timestamps) {
    timestamps = [];
    rateLimits.set(containerName, timestamps);
  }
  // Prune timestamps outside the window
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  while (timestamps.length > 0 && timestamps[0] <= cutoff) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  timestamps.push(now);
  return true;
}

// --- Request validation ---
export const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_PATH_PREFIXES = ["/v1/", "/api/"];
const ALLOWED_CONTENT_TYPES = ["application/json", "application/x-www-form-urlencoded"];
const PROXY_TOKEN_PREFIX = "/proxy/";

/** Extract and validate the proxy token from the URL path.
 *  Returns { containerName, strippedPath } on success, or null if invalid. */
function parseProxyToken(url: string): { containerName: string; strippedPath: string } | null {
  if (!url.startsWith(PROXY_TOKEN_PREFIX)) return null;
  const rest = url.slice(PROXY_TOKEN_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return null;
  const token = rest.slice(0, slashIdx);
  const strippedPath = rest.slice(slashIdx);
  const containerName = tokenToContainer.get(token);
  if (!containerName) return null;
  return { containerName, strippedPath };
}

function isAllowedPath(strippedPath: string): boolean {
  // Parse as URL to isolate pathname from query/fragment
  let pathname: string;
  try {
    pathname = new URL(strippedPath, "http://localhost").pathname;
  } catch {
    return false;
  }

  // Reject path traversal — decode each segment to catch %2e%2e encoding tricks
  const segments = pathname.split("/");
  for (const segment of segments) {
    if (!segment) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded === "." || decoded === "..") return false;
    // Reject encoded slashes (%2f) — a segment decoding to e.g. "../etc" would
    // bypass the traversal check and escape the allowlisted prefix if upstream
    // normalizes encoded slashes.
    if (decoded.includes("/")) return false;
  }

  return ALLOWED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isAllowedContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  // Content-Type may include charset, e.g. "application/json; charset=utf-8"
  const base = contentType.split(";")[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.includes(base);
}

/** Redact the per-container token from a raw URL for safe logging. */
function sanitizePath(rawUrl: string): string {
  if (!rawUrl.startsWith(PROXY_TOKEN_PREFIX)) return rawUrl;
  const rest = rawUrl.slice(PROXY_TOKEN_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx === -1) return PROXY_TOKEN_PREFIX + "<redacted>";
  return PROXY_TOKEN_PREFIX + "<redacted>" + rest.slice(slashIdx);
}

function rejectRequest(
  res: import("http").ServerResponse,
  status: number,
  reason: string,
  req: import("http").IncomingMessage,
): void {
  logger.warn(
    {
      event: "credential_proxy_rejected",
      reason,
      sourceIp: req.socket.remoteAddress,
      path: sanitizePath(req.url ?? ""),
      method: req.method,
    },
    "Proxy request rejected",
  );
  res.writeHead(status);
  res.end(reason);
}

// --- OAuth refresh ---

let inflightRefresh: Promise<string | null> | null = null;

/**
 * Refresh an OAuth token using the standard OAuth2 refresh_token grant.
 * Updates the credentials file on success so other processes benefit.
 * Deduplicates concurrent calls — only one refresh runs at a time.
 */
async function refreshOAuthToken(
  refreshToken: string,
  credentialsPath: string,
  creds: Record<string, any>,
): Promise<string | null> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = executeRefresh(refreshToken, credentialsPath, creds);
  try {
    const result = await inflightRefresh;
    if (!result) recordAuthFailure();
    return result;
  } finally {
    inflightRefresh = null;
  }
}

async function executeRefresh(
  refreshToken: string,
  credentialsPath: string,
  creds: Record<string, any>,
): Promise<string | null> {
  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", refreshToken);
  const body = params.toString();

  for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);

    try {
      const res = await fetch("https://platform.claude.com/v1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        if (RETRYABLE_STATUS.has(res.status) && attempt < REFRESH_MAX_RETRIES) {
          const delay = REFRESH_BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random() * 0.5);
          logger.warn({ status: res.status, attempt }, "OAuth refresh retryable error, retrying");
          await sleep(delay);
          continue;
        }
        const text = await res.text();
        logger.error({ status: res.status, body: text }, "OAuth refresh: non-retryable error");
        return null;
      }

      const data = (await res.json()) as Record<string, unknown>;
      if (data.access_token) {
        creds.claudeAiOauth.accessToken = data.access_token;
        if (data.expires_in) {
          creds.claudeAiOauth.expiresAt = Date.now() + (data.expires_in as number) * 1000;
        }
        if (data.refresh_token) {
          creds.claudeAiOauth.refreshToken = data.refresh_token;
        }
        const tmpPath = `${credentialsPath}.tmp.${process.pid}`;
        await writeFile(tmpPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
        await rename(tmpPath, credentialsPath);
        logger.info("OAuth token refreshed successfully");
        return data.access_token as string;
      }
      logger.error({ response: data }, "OAuth refresh: no access_token in response");
      return null;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        logger.error("OAuth token refresh timed out");
        return null;
      }
      if (err instanceof TypeError && attempt < REFRESH_MAX_RETRIES) {
        const delay = REFRESH_BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random() * 0.5);
        logger.warn({ err, attempt }, "OAuth refresh network error, retrying");
        await sleep(delay);
        continue;
      }
      logger.error({ err }, "OAuth token refresh failed");
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Resolve the current OAuth token for proxy injection.
 * Checks circuit breaker, prefers .env token, falls back to credentials file
 * with auto-refresh for expired tokens.
 */
async function resolveOAuthToken(envToken: string | undefined): Promise<string | undefined> {
  const circuit = checkCircuit();
  if (!circuit.allowed) {
    logger.warn(circuit.reason, "Circuit breaker blocked credential read");
    return envToken; // fall back to whatever we have
  }

  // Prefer .env CLAUDE_CODE_OAUTH_TOKEN (long-lived setup-token)
  if (envToken) return envToken;

  // Fall back to credentials file (short-lived /login token)
  const credentialsPath = path.join(
    process.env.HOME || "/home/node",
    ".claude",
    ".credentials.json",
  );
  try {
    const creds = JSON.parse(await readFile(credentialsPath, "utf-8"));
    const oauth = creds.claudeAiOauth;
    if (oauth?.accessToken) {
      const expiresAt = oauth.expiresAt || 0;
      const isExpired = Date.now() > expiresAt - 5 * 60 * 1000;

      if (isExpired && oauth.refreshToken) {
        const refreshed = await refreshOAuthToken(oauth.refreshToken, credentialsPath, creds);
        return refreshed || oauth.accessToken;
      }
      return oauth.accessToken;
    }
  } catch {
    logger.warn("No OAuth token available: .env empty and credentials file unreadable");
  }

  return undefined;
}

export function startCredentialProxy(port: number, host = "127.0.0.1"): Promise<Server> {
  const secrets = readEnvFile([
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? "api-key" : "oauth";
  const envOAuthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
  const isHttps = upstreamUrl.protocol === "https:";
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // --- Pre-body validation (no data read yet) ---

      // 1. Token authentication
      const parsed = parseProxyToken(req.url || "");
      if (!parsed) {
        rejectRequest(res, 403, "invalid_token", req);
        req.resume(); // drain the request body
        return;
      }
      const { containerName, strippedPath } = parsed;

      // 2. Rate limiting
      if (!checkRateLimit(containerName)) {
        rejectRequest(res, 429, "rate_limited", req);
        req.resume();
        return;
      }

      // 3. Method validation
      if (req.method !== "POST") {
        rejectRequest(res, 405, "method_not_allowed", req);
        req.resume();
        return;
      }

      // 4. Path validation
      if (!isAllowedPath(strippedPath)) {
        rejectRequest(res, 400, "bad_path", req);
        req.resume();
        return;
      }

      // 5. Content-Type validation
      if (!isAllowedContentType(req.headers["content-type"])) {
        rejectRequest(res, 415, "unsupported_content_type", req);
        req.resume();
        return;
      }

      // 6. Content-Length early reject
      const declaredLength = parseInt(req.headers["content-length"] || "0", 10);
      if (declaredLength > MAX_BODY_SIZE) {
        rejectRequest(res, 413, "body_too_large", req);
        req.resume();
        return;
      }

      // --- Body collection with size enforcement ---
      const chunks: Buffer[] = [];
      let bodySize = 0;
      let aborted = false;

      req.on("data", (c: Buffer) => {
        bodySize += c.length;
        if (bodySize > MAX_BODY_SIZE) {
          if (!aborted) {
            aborted = true;
            rejectRequest(res, 413, "body_too_large", req);
            req.destroy();
          }
          return;
        }
        chunks.push(c);
      });

      req.on("end", async () => {
        if (aborted) return;

        const body = Buffer.concat(chunks);

        // Audit log: credential injection
        logger.info(
          {
            event: "credential_proxy_request",
            container: containerName,
            method: req.method,
            path: strippedPath,
            authMode,
          },
          "Credential injected",
        );

        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          "content-length": body.length,
        };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers["connection"];
        delete headers["keep-alive"];
        delete headers["transfer-encoding"];

        if (authMode === "api-key") {
          // API key mode: inject x-api-key on every request
          delete headers["x-api-key"];
          headers["x-api-key"] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: resolve token on each request (handles refresh + credentials.json fallback)
          if (headers["authorization"]) {
            delete headers["authorization"];
            const token = await resolveOAuthToken(envOAuthToken);
            if (token) {
              headers["authorization"] = `Bearer ${token}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: strippedPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on("error", (err) => {
          logger.error({ err, url: strippedPath }, "Credential proxy upstream error");
          if (!res.headersSent) {
            res.writeHead(502);
            res.end("Bad Gateway");
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, "Credential proxy started");
      resolve(server);
    });

    server.on("error", reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(["ANTHROPIC_API_KEY"]);
  return secrets.ANTHROPIC_API_KEY ? "api-key" : "oauth";
}
