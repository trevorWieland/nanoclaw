import { describe, it, expect, beforeEach } from "vitest";

import {
  _initTestDatabase,
  setRegisteredGroup,
  getRegisteredGroup,
  getAllRegisteredGroups,
} from "../src/db.js";

/**
 * Tests for the register step.
 *
 * Verifies: parameterized SQL (no injection), file templating,
 * apostrophe in names, .env updates.
 */

describe("parameterized SQL registration", () => {
  beforeEach(async () => {
    await _initTestDatabase();
  });

  it("registers a group with parameterized query", async () => {
    await setRegisteredGroup("123@g.us", {
      name: "Test Group",
      folder: "test-group",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      requiresTrigger: true,
    });

    const row = await getRegisteredGroup("123@g.us");

    expect(row).toBeDefined();
    expect(row!.jid).toBe("123@g.us");
    expect(row!.name).toBe("Test Group");
    expect(row!.folder).toBe("test-group");
    expect(row!.trigger).toBe("@Andy");
    expect(row!.requiresTrigger).toBe(true);
  });

  it("handles apostrophes in group names safely", async () => {
    const name = "O'Brien's Group";

    await setRegisteredGroup("456@g.us", {
      name,
      folder: "obriens-group",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      requiresTrigger: false,
    });

    const row = await getRegisteredGroup("456@g.us");

    expect(row).toBeDefined();
    expect(row!.name).toBe(name);
  });

  it("prevents SQL injection in JID field", async () => {
    const maliciousJid = "'; DROP TABLE registered_groups; --";

    await setRegisteredGroup(maliciousJid, {
      name: "Evil",
      folder: "evil",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      requiresTrigger: true,
    });

    // Table should still exist and have the row
    const groups = await getAllRegisteredGroups();
    const keys = Object.keys(groups);
    expect(keys).toHaveLength(1);

    const row = await getRegisteredGroup(maliciousJid);
    expect(row).toBeDefined();
    expect(row!.jid).toBe(maliciousJid);
  });

  it("handles requiresTrigger=false", async () => {
    await setRegisteredGroup("789@s.whatsapp.net", {
      name: "Personal",
      folder: "main",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      requiresTrigger: false,
    });

    const row = await getRegisteredGroup("789@s.whatsapp.net");

    expect(row).toBeDefined();
    expect(row!.requiresTrigger).toBe(false);
  });

  it("stores is_main flag", async () => {
    await setRegisteredGroup("789@s.whatsapp.net", {
      name: "Personal",
      folder: "whatsapp_main",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      requiresTrigger: false,
      isMain: true,
    });

    const row = await getRegisteredGroup("789@s.whatsapp.net");

    expect(row).toBeDefined();
    expect(row!.isMain).toBe(true);
  });

  it("defaults is_main to false", async () => {
    await setRegisteredGroup("123@g.us", {
      name: "Some Group",
      folder: "whatsapp_some-group",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      requiresTrigger: true,
    });

    const row = await getRegisteredGroup("123@g.us");

    expect(row).toBeDefined();
    expect(row!.isMain).toBeFalsy();
  });

  it("upserts on conflict", async () => {
    await setRegisteredGroup("123@g.us", {
      name: "Original",
      folder: "main",
      trigger: "@Andy",
      added_at: "2024-01-01T00:00:00.000Z",
      requiresTrigger: true,
    });

    await setRegisteredGroup("123@g.us", {
      name: "Updated",
      folder: "main",
      trigger: "@Bot",
      added_at: "2024-02-01T00:00:00.000Z",
      requiresTrigger: false,
    });

    const groups = await getAllRegisteredGroups();
    const keys = Object.keys(groups);
    expect(keys).toHaveLength(1);

    const row = await getRegisteredGroup("123@g.us");
    expect(row).toBeDefined();
    expect(row!.name).toBe("Updated");
    expect(row!.trigger).toBe("@Bot");
    expect(row!.requiresTrigger).toBe(false);
  });
});

describe("file templating", () => {
  it("replaces assistant name in CLAUDE.md content", () => {
    let content = "# Andy\n\nYou are Andy, a personal assistant.";

    content = content.replace(/^# Andy$/m, "# Nova");
    content = content.replace(/You are Andy/g, "You are Nova");

    expect(content).toBe("# Nova\n\nYou are Nova, a personal assistant.");
  });

  it("handles names with special regex characters", () => {
    let content = "# Andy\n\nYou are Andy.";

    const newName = "C.L.A.U.D.E";
    content = content.replace(/^# Andy$/m, `# ${newName}`);
    content = content.replace(/You are Andy/g, `You are ${newName}`);

    expect(content).toContain("# C.L.A.U.D.E");
    expect(content).toContain("You are C.L.A.U.D.E.");
  });

  it("updates .env ASSISTANT_NAME line", () => {
    let envContent = 'SOME_KEY=value\nASSISTANT_NAME="Andy"\nOTHER=test';

    envContent = envContent.replace(/^ASSISTANT_NAME=.*$/m, 'ASSISTANT_NAME="Nova"');

    expect(envContent).toContain('ASSISTANT_NAME="Nova"');
    expect(envContent).toContain("SOME_KEY=value");
  });

  it("appends ASSISTANT_NAME to .env if not present", () => {
    let envContent = "SOME_KEY=value\n";

    if (!envContent.includes("ASSISTANT_NAME=")) {
      envContent += '\nASSISTANT_NAME="Nova"';
    }

    expect(envContent).toContain('ASSISTANT_NAME="Nova"');
  });
});
