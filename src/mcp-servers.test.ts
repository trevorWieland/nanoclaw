import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("./config.js", () => ({
  GROUPS_DIR: "/config/groups",
}));

import fs from "fs";
import { interpolateEnvVars, loadMcpServers } from "./mcp-servers.js";
import { logger } from "./logger.js";

vi.mock("fs");

// =========================================
// interpolateEnvVars
// =========================================

describe("interpolateEnvVars", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("replaces a single variable", () => {
    process.env.MY_VAR = "hello";
    const { result, missing } = interpolateEnvVars("http://${MY_VAR}/path");
    expect(result).toBe("http://hello/path");
    expect(missing).toEqual([]);
  });

  it("replaces multiple variables", () => {
    process.env.HOST = "example.com";
    process.env.PORT = "8080";
    const { result, missing } = interpolateEnvVars("http://${HOST}:${PORT}/api");
    expect(result).toBe("http://example.com:8080/api");
    expect(missing).toEqual([]);
  });

  it("reports missing variables", () => {
    delete process.env.MISSING_VAR;
    const { result, missing } = interpolateEnvVars("http://${MISSING_VAR}/path");
    expect(result).toBe("http://${MISSING_VAR}/path");
    expect(missing).toEqual(["MISSING_VAR"]);
  });

  it("returns string unchanged when no variables present", () => {
    const { result, missing } = interpolateEnvVars("http://example.com/path");
    expect(result).toBe("http://example.com/path");
    expect(missing).toEqual([]);
  });

  it("handles empty string", () => {
    const { result, missing } = interpolateEnvVars("");
    expect(result).toBe("");
    expect(missing).toEqual([]);
  });

  it("handles adjacent variables", () => {
    process.env.A = "foo";
    process.env.B = "bar";
    const { result, missing } = interpolateEnvVars("${A}${B}");
    expect(result).toBe("foobar");
    expect(missing).toEqual([]);
  });

  it("reports multiple missing variables", () => {
    delete process.env.X;
    delete process.env.Y;
    const { result, missing } = interpolateEnvVars("${X}:${Y}");
    expect(missing).toEqual(["X", "Y"]);
    expect(result).toBe("${X}:${Y}");
  });
});

// =========================================
// loadMcpServers
// =========================================

describe("loadMcpServers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns undefined when no config file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toBeUndefined();
  });

  it("loads global config with http server", () => {
    process.env.API_KEY = "secret123";
    const config = {
      vectordb: {
        type: "http",
        url: "http://example.com/mcp",
        headers: { Authorization: "Bearer ${API_KEY}" },
      },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      vectordb: {
        type: "http",
        url: "http://example.com/mcp",
        headers: { Authorization: "Bearer secret123" },
      },
    });
  });

  it("loads global config with sse server", () => {
    const config = {
      myserver: { type: "sse", url: "http://localhost:9090/sse" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      myserver: { type: "sse", url: "http://localhost:9090/sse" },
    });
  });

  it("merges per-group config over global config", () => {
    const globalConfig = {
      serverA: { type: "http", url: "http://global-a.com/mcp" },
      serverB: { type: "http", url: "http://global-b.com/mcp" },
    };
    const groupConfig = {
      serverB: { type: "sse", url: "http://group-b.com/sse" },
      serverC: { type: "http", url: "http://group-c.com/mcp" },
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p) === "/config/mcp-servers.json") return JSON.stringify(globalConfig);
      return JSON.stringify(groupConfig);
    });

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      serverA: { type: "http", url: "http://global-a.com/mcp" },
      serverB: { type: "sse", url: "http://group-b.com/sse" },
      serverC: { type: "http", url: "http://group-c.com/mcp" },
    });
  });

  it("filters out onlyMain servers for non-main groups", () => {
    const config = {
      mainOnly: { type: "http", url: "http://main.com/mcp", onlyMain: true },
      shared: { type: "http", url: "http://shared.com/mcp" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "other-group", false);
    expect(result).toEqual({
      shared: { type: "http", url: "http://shared.com/mcp" },
    });
  });

  it("keeps onlyMain servers for main groups", () => {
    const config = {
      mainOnly: { type: "http", url: "http://main.com/mcp", onlyMain: true },
      shared: { type: "http", url: "http://shared.com/mcp" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "main-group", true);
    expect(result).toEqual({
      mainOnly: { type: "http", url: "http://main.com/mcp" },
      shared: { type: "http", url: "http://shared.com/mcp" },
    });
  });

  it("throws on malformed JSON", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue("not valid json{");

    expect(() => loadMcpServers("/config/mcp-servers.json", "test-group", true)).toThrow();
  });

  it("throws on schema-invalid config", () => {
    const config = {
      bad: { type: "websocket", url: "ws://example.com" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    expect(() => loadMcpServers("/config/mcp-servers.json", "test-group", true)).toThrow();
  });

  it("skips server with missing env vars and logs error", () => {
    delete process.env.MISSING_KEY;
    const config = {
      needsKey: {
        type: "http",
        url: "http://example.com/mcp",
        headers: { Authorization: "Bearer ${MISSING_KEY}" },
      },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ server: "needsKey", missingVars: ["MISSING_KEY"] }),
      expect.stringContaining("Skipping MCP server"),
    );
  });

  it("returns valid servers even when some are skipped", () => {
    delete process.env.MISSING;
    process.env.PRESENT = "value";
    const config = {
      good: { type: "http", url: "http://example.com/${PRESENT}" },
      bad: { type: "http", url: "http://example.com/${MISSING}" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      good: { type: "http", url: "http://example.com/value" },
    });
  });

  it("returns undefined when all servers filtered by onlyMain", () => {
    const config = {
      mainOnly: { type: "http", url: "http://example.com/mcp", onlyMain: true },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "other-group", false);
    expect(result).toBeUndefined();
  });

  it("does not include headers key when entry has no headers", () => {
    const config = {
      noHeaders: { type: "http", url: "http://example.com/mcp" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      noHeaders: { type: "http", url: "http://example.com/mcp" },
    });
    expect(result!.noHeaders).not.toHaveProperty("headers");
  });
});
