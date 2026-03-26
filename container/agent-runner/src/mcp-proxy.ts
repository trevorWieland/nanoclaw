/**
 * Converts HTTP/SSE MCP server configs into stdio proxy configs so the
 * Claude Agent SDK manages them as child processes it can re-spawn on
 * session resume.
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export interface HttpMcpServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

/**
 * Wrap each HTTP/SSE MCP server entry as a stdio subprocess that proxies
 * MCP JSON-RPC to the remote endpoint via mcp-http-bridge.js.
 *
 * Returns undefined when there are no servers to wrap.
 */
export function wrapHttpMcpServers(
  servers: Record<string, HttpMcpServer> | undefined,
  bridgePath: string,
): Record<string, McpServerConfig> | undefined {
  if (!servers) return undefined;
  const entries = Object.entries(servers);
  if (entries.length === 0) return undefined;

  const wrapped: Record<string, McpServerConfig> = {};
  for (const [name, server] of entries) {
    const env: Record<string, string> = {
      MCP_PROXY_URL: server.url,
      MCP_PROXY_TYPE: server.type,
    };
    if (server.headers && Object.keys(server.headers).length > 0) {
      env.MCP_PROXY_HEADERS = JSON.stringify(server.headers);
    }
    wrapped[name] = {
      command: "node",
      args: [bridgePath],
      env,
    };
  }
  return wrapped;
}

/**
 * Build the full mcpServers record for a query() call.
 * Always includes the built-in nanoclaw stdio server, plus any HTTP/SSE
 * servers wrapped as stdio proxies.
 */
export function buildMcpServers(
  mcpServerPath: string,
  bridgePath: string,
  containerInput: {
    chatJid: string;
    groupFolder: string;
    isMain: boolean;
    mcpServers?: Record<string, HttpMcpServer>;
  },
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {
    nanoclaw: {
      command: "node",
      args: [mcpServerPath],
      env: {
        NANOCLAW_CHAT_JID: containerInput.chatJid,
        NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
        NANOCLAW_IS_MAIN: containerInput.isMain ? "1" : "0",
      },
    },
  };

  const wrapped = wrapHttpMcpServers(containerInput.mcpServers, bridgePath);
  if (wrapped) {
    Object.assign(servers, wrapped);
  }

  return servers;
}
