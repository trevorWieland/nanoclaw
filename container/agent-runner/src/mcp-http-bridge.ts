/**
 * MCP HTTP/SSE-to-stdio bridge.
 *
 * Standalone process spawned by the Claude Agent SDK as a stdio MCP server.
 * Transparently relays MCP JSON-RPC messages between stdin/stdout and a
 * remote HTTP or SSE endpoint.
 *
 * Configuration via environment variables:
 *   MCP_PROXY_URL     — Remote MCP server URL (required)
 *   MCP_PROXY_TYPE    — "http" or "sse" (required)
 *   MCP_PROXY_HEADERS — JSON-encoded headers object (optional)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

function fatal(msg: string): never {
  process.stderr.write(`mcp-http-bridge: ${msg}\n`);
  process.exit(1);
}

const url = process.env.MCP_PROXY_URL;
const type = process.env.MCP_PROXY_TYPE;
if (!url) fatal("MCP_PROXY_URL is required");
if (type !== "http" && type !== "sse")
  fatal(`MCP_PROXY_TYPE must be "http" or "sse", got "${type}"`);

let headers: Record<string, string> | undefined;
if (process.env.MCP_PROXY_HEADERS) {
  try {
    headers = JSON.parse(process.env.MCP_PROXY_HEADERS);
  } catch {
    fatal("MCP_PROXY_HEADERS is not valid JSON");
  }
}

const requestInit: RequestInit | undefined = headers ? { headers } : undefined;

// Create transports
const stdio = new StdioServerTransport();

let remote: Transport;
if (type === "http") {
  remote = new StreamableHTTPClientTransport(new URL(url), { requestInit });
} else {
  remote = new SSEClientTransport(new URL(url), { requestInit });
}

// Wire bidirectional relay
stdio.onmessage = (msg) => {
  remote.send(msg).catch((err) => {
    process.stderr.write(`mcp-http-bridge: send to remote failed: ${err}\n`);
  });
};

remote.onmessage = (msg) => {
  stdio.send(msg).catch((err) => {
    process.stderr.write(`mcp-http-bridge: send to stdio failed: ${err}\n`);
  });
};

// Propagate close/error
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  Promise.all([stdio.close().catch(() => {}), remote.close().catch(() => {})]).then(() =>
    process.exit(0),
  );
}

// Stdio close means the SDK closed the pipe — shut down cleanly.
stdio.onclose = shutdown;
// Remote close means the server disconnected — shut down so the SDK re-spawns us.
remote.onclose = shutdown;
stdio.onerror = (err) => {
  process.stderr.write(`mcp-http-bridge: stdio error: ${err}\n`);
  shutdown();
};
// Remote transport errors are non-fatal (e.g., SSE GET rejected by a
// stateless server).  Log but keep running — POST-based message exchange
// may still work.
remote.onerror = (err) => {
  process.stderr.write(`mcp-http-bridge: remote error: ${err}\n`);
};

// Start the stdio transport so we begin reading from stdin.
// For HTTP transports, start() attempts a GET for SSE streaming which some
// servers may not support — catch and log but don't abort.
try {
  await remote.start();
} catch (err) {
  process.stderr.write(`mcp-http-bridge: remote start failed (non-fatal): ${err}\n`);
}
await stdio.start();
