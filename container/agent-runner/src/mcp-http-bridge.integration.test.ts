/**
 * End-to-end test for the MCP HTTP-to-stdio bridge.
 *
 * Spins up a real Streamable HTTP MCP server with a test tool, spawns the
 * bridge as a child process, and verifies MCP JSON-RPC messages round-trip
 * through the stdio-to-HTTP relay.
 */

import { randomUUID } from "crypto";
import { createServer, type Server } from "http";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// MCP stdio protocol uses newline-delimited JSON (JSONL).
function encodeJsonRpc(msg: object): string {
  return JSON.stringify(msg) + "\n";
}

// Parse newline-delimited JSON messages from a buffer of stdio output.
function parseJsonRpcMessages(data: string): object[] {
  return data
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Wait for N JSON-RPC messages from the bridge stdout.
 * Accumulates data and parses eagerly.
 */
function waitForMessages(proc: ChildProcess, count: number, timeoutMs = 10_000): Promise<object[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const messages: object[] = [];
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for ${count} messages (got ${messages.length}): ${JSON.stringify(messages)}`,
        ),
      );
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      // Try to parse complete lines (JSONL format)
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline === -1) return;
      const complete = buffer.slice(0, lastNewline + 1);
      buffer = buffer.slice(lastNewline + 1);
      const parsed = parseJsonRpcMessages(complete);
      messages.push(...parsed);
      if (messages.length >= count) {
        clearTimeout(timer);
        proc.stdout!.off("data", onData);
        resolve(messages.slice(0, count));
      }
    };

    proc.stdout!.on("data", onData);

    proc.on("exit", () => {
      clearTimeout(timer);
      if (messages.length >= count) {
        resolve(messages.slice(0, count));
      } else {
        reject(
          new Error(
            `Bridge exited before ${count} messages (got ${messages.length}): ${JSON.stringify(messages)}`,
          ),
        );
      }
    });
  });
}

/**
 * Create a stateful Streamable HTTP MCP server that maintains sessions
 * across requests (required for multi-message MCP protocol flows).
 */
function createTestMcpServer(registerTools: (server: McpServer) => void): {
  server: Server;
  cleanup: () => Promise<void>;
} {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport }>();

  const server = createServer(async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — route to its transport
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
    } else if (!sessionId && req.method === "POST") {
      // New session — create mcpServer + transport
      const mcpServer = new McpServer({ name: "test-server", version: "1.0.0" });
      registerTools(mcpServer);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport });
      }
    } else {
      res.writeHead(400).end("Bad request");
    }
  });

  const cleanup = async () => {
    for (const { transport } of sessions.values()) {
      await transport.close().catch(() => {});
    }
    sessions.clear();
  };

  return { server, cleanup };
}

describe("mcp-http-bridge end-to-end", () => {
  let httpServer: Server;
  let serverCleanup: () => Promise<void>;
  let serverPort: number;
  let bridge: ChildProcess | undefined;

  beforeEach(async () => {
    const created = createTestMcpServer((server) => {
      server.tool("echo", "Echoes the input back", { message: z.string() }, async (args) => ({
        content: [{ type: "text" as const, text: `echo: ${args.message}` }],
      }));
    });
    httpServer = created.server;
    serverCleanup = created.cleanup;

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = httpServer.address();
    serverPort = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    if (bridge && !bridge.killed) {
      bridge.kill("SIGKILL");
      await new Promise((resolve) => {
        bridge!.on("exit", resolve);
        setTimeout(resolve, 1000); // fallback if exit never fires
      });
    }
    bridge = undefined;
    await serverCleanup();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function spawnBridge(env: Record<string, string>): ChildProcess {
    const bridgeSrc = path.resolve(__dirname, "mcp-http-bridge.ts");
    bridge = spawn("npx", ["tsx", bridgeSrc], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Capture stderr for debugging
    let stderr = "";
    bridge.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    bridge.on("exit", (code) => {
      if (code && code !== 0 && stderr) {
        process.stderr.write(`[bridge-test] bridge stderr:\n${stderr}\n`);
      }
    });

    return bridge;
  }

  /** Send initialize + notifications/initialized, return the init response */
  async function initializeBridge(proc: ChildProcess): Promise<object> {
    proc.stdin!.write(
      encodeJsonRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    );

    const [initResponse] = await waitForMessages(proc, 1);

    // Send initialized notification (required by MCP protocol)
    proc.stdin!.write(
      encodeJsonRpc({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    );

    return initResponse;
  }

  it("relays initialize and tools/list through the bridge", async () => {
    const proc = spawnBridge({
      MCP_PROXY_URL: `http://127.0.0.1:${serverPort}`,
      MCP_PROXY_TYPE: "http",
    });

    const initResponse = await initializeBridge(proc);
    expect(initResponse).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: expect.any(String),
        serverInfo: { name: "test-server" },
      },
    });

    // Send tools/list request
    proc.stdin!.write(
      encodeJsonRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    );

    const [toolsResponse] = await waitForMessages(proc, 1);
    expect(toolsResponse).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [expect.objectContaining({ name: "echo" })],
      },
    });
  }, 15_000);

  it("relays tools/call and returns tool result", async () => {
    const proc = spawnBridge({
      MCP_PROXY_URL: `http://127.0.0.1:${serverPort}`,
      MCP_PROXY_TYPE: "http",
    });

    await initializeBridge(proc);

    // Call the echo tool
    proc.stdin!.write(
      encodeJsonRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { message: "hello from bridge test" },
        },
      }),
    );

    const [callResponse] = await waitForMessages(proc, 1);
    expect(callResponse).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "text", text: "echo: hello from bridge test" }],
      },
    });
  }, 15_000);

  it("passes custom headers to the remote server", async () => {
    // Create a server that captures headers
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const headerServer = createServer(async (req, res) => {
      receivedHeaders = { ...req.headers };
      const mcpServer = new McpServer({ name: "header-test", version: "1.0.0" });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => headerServer.listen(0, "127.0.0.1", () => resolve()));
    const hAddr = headerServer.address();
    const hPort = typeof hAddr === "object" && hAddr ? hAddr.port : 0;

    try {
      const proc = spawnBridge({
        MCP_PROXY_URL: `http://127.0.0.1:${hPort}`,
        MCP_PROXY_TYPE: "http",
        MCP_PROXY_HEADERS: JSON.stringify({ "X-Test-Token": "secret123" }),
      });

      await initializeBridge(proc);
      expect(receivedHeaders["x-test-token"]).toBe("secret123");
    } finally {
      await new Promise<void>((resolve) => headerServer.close(() => resolve()));
    }
  }, 15_000);

  it("exits with error for missing MCP_PROXY_URL", async () => {
    const bridgeSrc = path.resolve(__dirname, "mcp-http-bridge.ts");
    const proc = spawn("npx", ["tsx", bridgeSrc], {
      env: { ...process.env, MCP_PROXY_TYPE: "http", MCP_PROXY_URL: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const code = await new Promise<number | null>((resolve) => proc.on("exit", resolve));
    // Drain stderr after exit
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(code).toBe(1);
    expect(stderr).toContain("MCP_PROXY_URL is required");
  }, 15_000);
});
