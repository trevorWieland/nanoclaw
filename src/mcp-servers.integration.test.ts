import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =========================================
// Mocks — only config, env, and logger are mocked.
// fs is REAL (integration test uses actual temp dirs).
// =========================================

const mockConfig = vi.hoisted(() => ({
  groupsDir: "",
}));

vi.mock("./config.js", () => ({
  get GROUPS_DIR() {
    return mockConfig.groupsDir;
  },
}));

vi.mock("./env.js", () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { loadMcpServers } from "./mcp-servers.js";
import { readEnvFile } from "./env.js";
import { logger } from "./logger.js";

// =========================================
// Setup / teardown
// =========================================

let tmpDir: string;
const originalEnv = process.env;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-int-test-"));
  mockConfig.groupsDir = tmpDir;
  process.env = { ...originalEnv };
  vi.clearAllMocks();
  vi.mocked(readEnvFile).mockReturnValue({});
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================
// Helpers
// =========================================

function writeGlobalConfig(data: Record<string, unknown>): string {
  const filePath = path.join(tmpDir, "mcp-servers.json");
  fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
  return filePath;
}

function writeGroupConfig(groupFolder: string, data: Record<string, unknown>): void {
  const groupDir = path.join(tmpDir, groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(path.join(groupDir, "mcp-servers.json"), JSON.stringify(data), "utf-8");
}

// =========================================
// Tests
// =========================================

describe("MCP servers integration", () => {
  it("global config with ${VAR} resolves env vars", () => {
    process.env.TANREN_API_URL = "api.tanren.dev";
    vi.mocked(readEnvFile).mockReturnValue({ TANREN_API_URL: "api.tanren.dev" });

    const globalPath = writeGlobalConfig({
      tanren: { type: "http", url: "https://${TANREN_API_URL}/v1" },
    });

    const result = loadMcpServers(globalPath, "test-group", true);

    expect(result).toEqual({
      tanren: { type: "http", url: "https://api.tanren.dev/v1" },
    });
  });

  it("per-group config overrides global for same server name", () => {
    const globalPath = writeGlobalConfig({
      shared: { type: "http", url: "https://global.example.com" },
    });
    writeGroupConfig("test-group", {
      shared: { type: "http", url: "https://group.example.com" },
    });

    const result = loadMcpServers(globalPath, "test-group", true);

    expect(result).toEqual({
      shared: { type: "http", url: "https://group.example.com" },
    });
  });

  it("per-group config with ${VAR} patterns rejected", () => {
    const globalPath = writeGlobalConfig({});
    writeGroupConfig("test-group", {
      bad: { type: "http", url: "https://${SECRET}/api" },
    });

    const result = loadMcpServers(globalPath, "test-group", true);

    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ server: "bad", fields: ["url"] }),
      expect.stringContaining("not allowed in per-group configs"),
    );
  });

  it("onlyMain server excluded for non-main groups", () => {
    const globalPath = writeGlobalConfig({
      "admin-tool": { type: "http", url: "https://admin.example.com", onlyMain: true },
    });

    const result = loadMcpServers(globalPath, "test-group", false);

    expect(result).toBeUndefined();
  });

  it("onlyMain server included for main groups", () => {
    const globalPath = writeGlobalConfig({
      "admin-tool": { type: "http", url: "https://admin.example.com", onlyMain: true },
    });

    const result = loadMcpServers(globalPath, "test-group", true);

    expect(result).toEqual({
      "admin-tool": { type: "http", url: "https://admin.example.com" },
    });
  });

  it("reserved name 'nanoclaw' rejected", () => {
    const globalPath = writeGlobalConfig({
      nanoclaw: { type: "http", url: "https://evil.example.com" },
    });

    expect(() => loadMcpServers(globalPath, "test-group", true)).toThrow(/reserved.*nanoclaw/i);
  });

  it("symlink config file rejected", () => {
    // Write a real config, then create a symlink pointing to it
    const realPath = path.join(tmpDir, "real-mcp-servers.json");
    fs.writeFileSync(
      realPath,
      JSON.stringify({ ok: { type: "http", url: "https://ok.example.com" } }),
      "utf-8",
    );

    const symlinkPath = path.join(tmpDir, "symlink-mcp-servers.json");
    try {
      fs.symlinkSync(realPath, symlinkPath);
    } catch {
      // Skip if platform doesn't support symlinks (e.g. unprivileged Windows)
      return;
    }

    const result = loadMcpServers(symlinkPath, "test-group", true);

    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: symlinkPath }),
      expect.stringContaining("symlink"),
    );
  });

  it("oversized config file (>64KB) rejected", () => {
    // Create a valid JSON object padded to exceed 64KB
    const padding = " ".repeat(70_000);
    const oversizedJson = `{"big":{"type":"http","url":"https://example.com"},"_pad":"${padding}"}`;
    const filePath = path.join(tmpDir, "mcp-servers.json");
    fs.writeFileSync(filePath, oversizedJson, "utf-8");

    const result = loadMcpServers(filePath, "test-group", true);

    expect(result).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ filePath }),
      expect.stringContaining("exceeds size limit"),
    );
  });
});
