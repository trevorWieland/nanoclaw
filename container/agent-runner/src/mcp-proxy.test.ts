import { describe, expect, it } from "vitest";
import { wrapHttpMcpServers, buildMcpServers } from "./mcp-proxy.js";

const BRIDGE = "/tmp/dist/mcp-http-bridge.js";

describe("wrapHttpMcpServers", () => {
  it("converts HTTP server to stdio proxy config", () => {
    const result = wrapHttpMcpServers(
      { tanren: { type: "http", url: "https://api.tanren.dev/v1" } },
      BRIDGE,
    );

    expect(result).toEqual({
      tanren: {
        command: "node",
        args: [BRIDGE],
        env: { MCP_PROXY_URL: "https://api.tanren.dev/v1", MCP_PROXY_TYPE: "http" },
      },
    });
  });

  it("converts SSE server to stdio proxy config", () => {
    const result = wrapHttpMcpServers(
      { events: { type: "sse", url: "http://localhost:8080/mcp" } },
      BRIDGE,
    );

    expect(result).toEqual({
      events: {
        command: "node",
        args: [BRIDGE],
        env: { MCP_PROXY_URL: "http://localhost:8080/mcp", MCP_PROXY_TYPE: "sse" },
      },
    });
  });

  it("serializes headers to MCP_PROXY_HEADERS env var", () => {
    const result = wrapHttpMcpServers(
      {
        authed: {
          type: "http",
          url: "https://example.com",
          headers: { Authorization: "Bearer tok123", "X-Custom": "val" },
        },
      },
      BRIDGE,
    );

    const env = (result!.authed as { env: Record<string, string> }).env;
    expect(env.MCP_PROXY_HEADERS).toBeDefined();
    expect(JSON.parse(env.MCP_PROXY_HEADERS)).toEqual({
      Authorization: "Bearer tok123",
      "X-Custom": "val",
    });
  });

  it("omits MCP_PROXY_HEADERS when headers are absent", () => {
    const result = wrapHttpMcpServers(
      { simple: { type: "http", url: "https://example.com" } },
      BRIDGE,
    );

    const env = (result!.simple as { env: Record<string, string> }).env;
    expect(env.MCP_PROXY_HEADERS).toBeUndefined();
  });

  it("omits MCP_PROXY_HEADERS when headers object is empty", () => {
    const result = wrapHttpMcpServers(
      { simple: { type: "http", url: "https://example.com", headers: {} } },
      BRIDGE,
    );

    const env = (result!.simple as { env: Record<string, string> }).env;
    expect(env.MCP_PROXY_HEADERS).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(wrapHttpMcpServers(undefined, BRIDGE)).toBeUndefined();
  });

  it("returns undefined for empty object input", () => {
    expect(wrapHttpMcpServers({}, BRIDGE)).toBeUndefined();
  });

  it("wraps multiple servers", () => {
    const result = wrapHttpMcpServers(
      {
        alpha: { type: "http", url: "https://alpha.example.com" },
        beta: { type: "sse", url: "https://beta.example.com" },
      },
      BRIDGE,
    );

    expect(result).toBeDefined();
    expect(Object.keys(result!)).toEqual(["alpha", "beta"]);
    expect((result!.alpha as { env: Record<string, string> }).env.MCP_PROXY_TYPE).toBe("http");
    expect((result!.beta as { env: Record<string, string> }).env.MCP_PROXY_TYPE).toBe("sse");
  });
});

describe("buildMcpServers", () => {
  const MCP_SERVER = "/tmp/dist/ipc-mcp-stdio.js";
  const BASE_INPUT = {
    chatJid: "chat@example.com",
    groupFolder: "test-group",
    isMain: true,
  };

  it("always includes nanoclaw stdio server", () => {
    const result = buildMcpServers(MCP_SERVER, BRIDGE, BASE_INPUT);

    expect(result.nanoclaw).toEqual({
      command: "node",
      args: [MCP_SERVER],
      env: {
        NANOCLAW_CHAT_JID: "chat@example.com",
        NANOCLAW_GROUP_FOLDER: "test-group",
        NANOCLAW_IS_MAIN: "1",
      },
    });
  });

  it("sets NANOCLAW_IS_MAIN to 0 for non-main groups", () => {
    const result = buildMcpServers(MCP_SERVER, BRIDGE, { ...BASE_INPUT, isMain: false });

    expect((result.nanoclaw as { env: Record<string, string> }).env.NANOCLAW_IS_MAIN).toBe("0");
  });

  it("includes wrapped HTTP/SSE servers alongside nanoclaw", () => {
    const result = buildMcpServers(MCP_SERVER, BRIDGE, {
      ...BASE_INPUT,
      mcpServers: {
        tanren: { type: "http", url: "https://api.tanren.dev/v1" },
      },
    });

    expect(Object.keys(result)).toEqual(["nanoclaw", "tanren"]);
    expect((result.tanren as { env: Record<string, string> }).env.MCP_PROXY_TYPE).toBe("http");
  });

  it("returns only nanoclaw when no mcpServers provided", () => {
    const result = buildMcpServers(MCP_SERVER, BRIDGE, BASE_INPUT);

    expect(Object.keys(result)).toEqual(["nanoclaw"]);
  });

  it("returns only nanoclaw when mcpServers is empty", () => {
    const result = buildMcpServers(MCP_SERVER, BRIDGE, { ...BASE_INPUT, mcpServers: {} });

    expect(Object.keys(result)).toEqual(["nanoclaw"]);
  });
});
