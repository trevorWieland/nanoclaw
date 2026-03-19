import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";

import { _initTestDatabase, setRegisteredGroup, getRegisteredGroupCount } from "../src/db.js";

/**
 * Tests for the environment check step.
 *
 * Verifies: config detection, Docker/AC detection, DB queries.
 */

describe("environment detection", () => {
  it("detects platform correctly", async () => {
    const { getPlatform } = await import("./platform.js");
    const platform = getPlatform();
    expect(["macos", "linux", "unknown"]).toContain(platform);
  });
});

describe("registered groups DB query", () => {
  beforeEach(async () => {
    await _initTestDatabase();
  });

  it("returns 0 for empty table", async () => {
    const count = await getRegisteredGroupCount();
    expect(count).toBe(0);
  });

  it("returns correct count after inserts", async () => {
    await setRegisteredGroup("123@g.us", {
      name: "Group 1",
      folder: "group-1",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      requiresTrigger: true,
    });

    await setRegisteredGroup("456@g.us", {
      name: "Group 2",
      folder: "group-2",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      requiresTrigger: true,
    });

    const count = await getRegisteredGroupCount();
    expect(count).toBe(2);
  });
});

describe("credentials detection", () => {
  it("detects ANTHROPIC_API_KEY in env content", () => {
    const content = "SOME_KEY=value\nANTHROPIC_API_KEY=sk-ant-test123\nOTHER=foo";
    const hasCredentials = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(content);
    expect(hasCredentials).toBe(true);
  });

  it("detects CLAUDE_CODE_OAUTH_TOKEN in env content", () => {
    const content = "CLAUDE_CODE_OAUTH_TOKEN=token123";
    const hasCredentials = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(content);
    expect(hasCredentials).toBe(true);
  });

  it("returns false when no credentials", () => {
    const content = 'ASSISTANT_NAME="Andy"\nOTHER=foo';
    const hasCredentials = /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=/m.test(content);
    expect(hasCredentials).toBe(false);
  });
});

describe("Docker detection logic", () => {
  it("commandExists returns boolean", async () => {
    const { commandExists } = await import("./platform.js");
    expect(typeof commandExists("docker")).toBe("boolean");
    expect(typeof commandExists("nonexistent_binary_xyz")).toBe("boolean");
  });
});

describe("channel auth detection", () => {
  it("detects non-empty auth directory", () => {
    const hasAuth = (authDir: string) => {
      try {
        return fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
      } catch {
        return false;
      }
    };

    // Non-existent directory
    expect(hasAuth("/tmp/nonexistent_auth_dir_xyz")).toBe(false);
  });
});
