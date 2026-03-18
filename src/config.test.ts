import { createHash } from "crypto";
import path from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

const envFileData = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock("./env.js", () => ({
  readEnvFile: vi.fn(() => envFileData.current),
}));

describe("parseIntEnv validation", () => {
  afterEach(() => {
    delete process.env.CONTAINER_TIMEOUT;
    delete process.env.CHANNEL_CONNECT_TIMEOUT;
    envFileData.current = {};
    vi.resetModules();
  });

  it("throws on non-numeric env value", async () => {
    process.env.CONTAINER_TIMEOUT = "abc";
    await expect(import("./config.js")).rejects.toThrow(
      'Invalid integer for CONTAINER_TIMEOUT: "abc"',
    );
  });

  it("throws on partially numeric env value", async () => {
    process.env.CHANNEL_CONNECT_TIMEOUT = "30s";
    await expect(import("./config.js")).rejects.toThrow(
      'Invalid integer for CHANNEL_CONNECT_TIMEOUT: "30s"',
    );
  });

  it("uses env value when set to a valid integer", async () => {
    process.env.CHANNEL_CONNECT_TIMEOUT = "5000";
    const mod = await import("./config.js");
    expect(mod.CHANNEL_CONNECT_TIMEOUT).toBe(5000);
  });

  it("uses default when env var is not set", async () => {
    delete process.env.CHANNEL_CONNECT_TIMEOUT;
    const mod = await import("./config.js");
    expect(mod.CHANNEL_CONNECT_TIMEOUT).toBe(30000);
  });

  it("reads integer from .env file when process.env is unset", async () => {
    delete process.env.CHANNEL_CONNECT_TIMEOUT;
    envFileData.current = { CHANNEL_CONNECT_TIMEOUT: "15000" };
    const mod = await import("./config.js");
    expect(mod.CHANNEL_CONNECT_TIMEOUT).toBe(15000);
  });

  it("process.env takes precedence over .env file", async () => {
    process.env.CHANNEL_CONNECT_TIMEOUT = "5000";
    envFileData.current = { CHANNEL_CONNECT_TIMEOUT: "15000" };
    const mod = await import("./config.js");
    expect(mod.CHANNEL_CONNECT_TIMEOUT).toBe(5000);
  });
});

describe("config path resolution", () => {
  afterEach(() => {
    delete process.env.NANOCLAW_CONFIG_ROOT;
    vi.resetModules();
  });

  it("keeps GROUPS_DIR under project root by default", async () => {
    const mod = await import("./config.js");
    expect(mod.GROUPS_DIR).toBe(path.resolve(process.cwd(), "groups"));
  });

  it("moves GROUPS_DIR under NANOCLAW_CONFIG_ROOT when provided", async () => {
    process.env.NANOCLAW_CONFIG_ROOT = "/tmp/nanoclaw-config";
    const mod = await import("./config.js");
    expect(mod.GROUPS_DIR).toBe("/tmp/nanoclaw-config/groups");
  });
});

describe("INSTANCE_ID", () => {
  afterEach(() => {
    delete process.env.NANOCLAW_INSTANCE_ID;
    delete process.env.NANOCLAW_CONFIG_ROOT;
    vi.resetModules();
  });

  it("uses NANOCLAW_INSTANCE_ID env var when set", async () => {
    process.env.NANOCLAW_INSTANCE_ID = "custom-id";
    const mod = await import("./config.js");
    expect(mod.INSTANCE_ID).toBe("custom-id");
  });

  it("falls back to 8-char hex hash of CONFIG_ROOT when env var is unset", async () => {
    delete process.env.NANOCLAW_INSTANCE_ID;
    const mod = await import("./config.js");
    const expected = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 8);
    expect(mod.INSTANCE_ID).toBe(expected);
    expect(mod.INSTANCE_ID).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces stable hash across reimports", async () => {
    delete process.env.NANOCLAW_INSTANCE_ID;
    const mod1 = await import("./config.js");
    const id1 = mod1.INSTANCE_ID;
    vi.resetModules();
    const mod2 = await import("./config.js");
    expect(mod2.INSTANCE_ID).toBe(id1);
  });
});
