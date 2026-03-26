import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, it, expect, beforeEach } from "vitest";

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
 * apostrophe in names, .env updates, CLAUDE.md template copy.
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

describe("CLAUDE.md template copy", () => {
  let tmpDir: string;
  let groupsDir: string;

  // Replicates register.ts template copy + name update logic
  function simulateRegister(folder: string, isMain: boolean, assistantName = "Andy"): void {
    const folderDir = path.join(groupsDir, folder);
    fs.mkdirSync(path.join(folderDir, "logs"), { recursive: true });

    // Template copy — never overwrite existing (register.ts lines 119-135)
    const dest = path.join(folderDir, "CLAUDE.md");
    if (!fs.existsSync(dest)) {
      const templatePath = isMain
        ? path.join(groupsDir, "main", "CLAUDE.md")
        : path.join(groupsDir, "global", "CLAUDE.md");
      if (fs.existsSync(templatePath)) {
        fs.copyFileSync(templatePath, dest);
      }
    }

    // Name update across all groups (register.ts lines 140-165)
    if (assistantName !== "Andy") {
      const mdFiles = fs
        .readdirSync(groupsDir)
        .map((d) => path.join(groupsDir, d, "CLAUDE.md"))
        .filter((f) => fs.existsSync(f));

      for (const mdFile of mdFiles) {
        let content = fs.readFileSync(mdFile, "utf-8");
        content = content.replace(/^# Andy$/m, `# ${assistantName}`);
        content = content.replace(/You are Andy/g, `You are ${assistantName}`);
        fs.writeFileSync(mdFile, content);
      }
    }
  }

  function readGroupMd(folder: string): string {
    return fs.readFileSync(path.join(groupsDir, folder, "CLAUDE.md"), "utf-8");
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nanoclaw-register-test-"));
    groupsDir = path.join(tmpDir, "groups");
    fs.mkdirSync(path.join(groupsDir, "main"), { recursive: true });
    fs.mkdirSync(path.join(groupsDir, "global"), { recursive: true });
    fs.writeFileSync(
      path.join(groupsDir, "main", "CLAUDE.md"),
      "# Andy\n\nYou are Andy, a personal assistant.\n\n## Admin Context\n\nThis is the **main channel**.",
    );
    fs.writeFileSync(
      path.join(groupsDir, "global", "CLAUDE.md"),
      "# Andy\n\nYou are Andy, a personal assistant.",
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("copies global template for non-main group", () => {
    simulateRegister("telegram_dev-team", false);

    const content = readGroupMd("telegram_dev-team");
    expect(content).toContain("You are Andy");
    expect(content).not.toContain("Admin Context");
  });

  it("copies main template for main group", () => {
    simulateRegister("whatsapp_main", true);

    expect(readGroupMd("whatsapp_main")).toContain("Admin Context");
  });

  it("each channel can have its own main with admin context", () => {
    simulateRegister("whatsapp_main", true);
    simulateRegister("telegram_main", true);
    simulateRegister("slack_main", true);
    simulateRegister("discord_main", true);

    for (const folder of ["whatsapp_main", "telegram_main", "slack_main", "discord_main"]) {
      const content = readGroupMd(folder);
      expect(content).toContain("Admin Context");
      expect(content).toContain("You are Andy");
    }
  });

  it("non-main groups across channels get global template", () => {
    simulateRegister("whatsapp_main", true);
    simulateRegister("telegram_friends", false);
    simulateRegister("slack_engineering", false);
    simulateRegister("discord_general", false);

    expect(readGroupMd("whatsapp_main")).toContain("Admin Context");
    for (const folder of ["telegram_friends", "slack_engineering", "discord_general"]) {
      const content = readGroupMd(folder);
      expect(content).toContain("You are Andy");
      expect(content).not.toContain("Admin Context");
    }
  });

  it("custom name propagates to all channels and groups", () => {
    // Register multiple channels, last one sets custom name
    simulateRegister("whatsapp_main", true);
    simulateRegister("telegram_main", true);
    simulateRegister("slack_devs", false);
    // Final registration triggers name update across all
    simulateRegister("discord_main", true, "Luna");

    for (const folder of [
      "main",
      "global",
      "whatsapp_main",
      "telegram_main",
      "slack_devs",
      "discord_main",
    ]) {
      const content = readGroupMd(folder);
      expect(content).toContain("# Luna");
      expect(content).toContain("You are Luna");
      expect(content).not.toContain("Andy");
    }
  });

  it("never overwrites existing CLAUDE.md on re-registration", () => {
    simulateRegister("slack_main", true);
    // User customizes the file extensively (persona, workspace, rules)
    const mdPath = path.join(groupsDir, "slack_main", "CLAUDE.md");
    fs.writeFileSync(mdPath, "# Gambi\n\nCustom persona with workspace rules and family context.");
    // Re-registering same folder (e.g. re-running /add-slack)
    simulateRegister("slack_main", true);

    const content = readGroupMd("slack_main");
    expect(content).toContain("Custom persona");
    expect(content).not.toContain("Admin Context");
  });

  it("never overwrites when non-main becomes main (isMain changes)", () => {
    // User registers a family group as non-main
    simulateRegister("whatsapp_casa", false);
    // User extensively customizes it (PARA system, task management, etc.)
    const mdPath = path.join(groupsDir, "whatsapp_casa", "CLAUDE.md");
    fs.writeFileSync(
      mdPath,
      "# Casa\n\nFamily group with PARA system, task management, shopping lists.",
    );
    // Later, user promotes to main (no trigger required) — CLAUDE.md must be preserved
    simulateRegister("whatsapp_casa", true);

    const content = readGroupMd("whatsapp_casa");
    expect(content).toContain("PARA system");
    expect(content).not.toContain("Admin Context");
  });

  it("preserves custom CLAUDE.md across channels when changing main", () => {
    // Real-world scenario: WhatsApp main + customized Discord research channel
    simulateRegister("whatsapp_main", true);
    simulateRegister("discord_main", false);
    const discordPath = path.join(groupsDir, "discord_main", "CLAUDE.md");
    fs.writeFileSync(
      discordPath,
      "# Gambi HQ — Research Assistant\n\nResearch workflows for Laura and Ethan.",
    );

    // Discord becomes main too — custom content must survive
    simulateRegister("discord_main", true);
    expect(readGroupMd("discord_main")).toContain("Research Assistant");
    // WhatsApp main also untouched
    expect(readGroupMd("whatsapp_main")).toContain("Admin Context");
  });

  it("handles missing templates gracefully", () => {
    fs.unlinkSync(path.join(groupsDir, "global", "CLAUDE.md"));
    fs.unlinkSync(path.join(groupsDir, "main", "CLAUDE.md"));

    simulateRegister("discord_general", false);

    expect(fs.existsSync(path.join(groupsDir, "discord_general", "CLAUDE.md"))).toBe(false);
  });
});
