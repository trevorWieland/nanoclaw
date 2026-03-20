import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ tmpDir: "" }));

vi.mock("./runtime-paths.js", () => ({
  get CONFIG_ROOT() {
    return testState.tmpDir;
  },
}));

// group-folder.ts imports from config.js — stub the values it needs
vi.mock("./config.js", () => ({
  DATA_DIR: "/tmp/test-data",
  GROUPS_DIR: "/tmp/test-groups",
}));

vi.mock("./logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { loadDeclarativeGroups } from "./declarative-groups.js";
import { logger } from "./logger.js";

beforeEach(() => {
  testState.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "decl-groups-test-"));
});

afterEach(() => {
  fs.rmSync(testState.tmpDir, { recursive: true, force: true });
});

function writeGroupsFile(data: unknown): void {
  fs.writeFileSync(path.join(testState.tmpDir, "registered-groups.json"), JSON.stringify(data));
}

describe("loadDeclarativeGroups", () => {
  it("returns empty array when file is missing", () => {
    expect(loadDeclarativeGroups()).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    fs.writeFileSync(path.join(testState.tmpDir, "registered-groups.json"), "not json{");
    expect(loadDeclarativeGroups()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining("registered-groups.json") }),
      "declarative-groups: invalid JSON",
    );
  });

  it("returns empty array when file is not an array", () => {
    writeGroupsFile({ jid: "test" });
    expect(loadDeclarativeGroups()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining("registered-groups.json") }),
      "declarative-groups: expected array",
    );
  });

  it("parses valid entries", () => {
    writeGroupsFile([
      {
        jid: "120363xxx@g.us",
        name: "My Group",
        folder: "my_group",
        trigger: "@Andy",
        requiresTrigger: true,
        isMain: false,
      },
    ]);

    const result = loadDeclarativeGroups();
    expect(result).toHaveLength(1);
    expect(result[0].jid).toBe("120363xxx@g.us");
    expect(result[0].group.name).toBe("My Group");
    expect(result[0].group.folder).toBe("my_group");
    expect(result[0].group.trigger).toBe("@Andy");
    expect(result[0].group.requiresTrigger).toBe(true);
    expect(result[0].group.isMain).toBe(false);
    expect(result[0].group.added_at).toBeTruthy();
  });

  it("skips entries with missing required fields", () => {
    writeGroupsFile([
      { jid: "valid@g.us", name: "Valid", folder: "valid", trigger: "@Andy" },
      { jid: "missing-name@g.us", folder: "test", trigger: "@Andy" },
      { name: "No JID", folder: "test2", trigger: "@Andy" },
    ]);

    const result = loadDeclarativeGroups();
    expect(result).toHaveLength(1);
    expect(result[0].jid).toBe("valid@g.us");
  });

  it("skips entries with invalid folder names", () => {
    writeGroupsFile([
      { jid: "bad@g.us", name: "Bad", folder: "../escape", trigger: "@Andy" },
      { jid: "reserved@g.us", name: "Reserved", folder: "global", trigger: "@Andy" },
      { jid: "good@g.us", name: "Good", folder: "valid_folder", trigger: "@Andy" },
    ]);

    const result = loadDeclarativeGroups();
    expect(result).toHaveLength(1);
    expect(result[0].jid).toBe("good@g.us");
  });

  it("includes containerConfig when provided", () => {
    writeGroupsFile([
      {
        jid: "test@g.us",
        name: "Test",
        folder: "test",
        trigger: "@Andy",
        containerConfig: {
          additionalMounts: [{ hostPath: "/host/repo", readonly: false }],
          timeout: 600000,
        },
      },
    ]);

    const result = loadDeclarativeGroups();
    expect(result[0].group.containerConfig?.timeout).toBe(600000);
    expect(result[0].group.containerConfig?.additionalMounts).toHaveLength(1);
  });

  it("handles empty array gracefully", () => {
    writeGroupsFile([]);
    expect(loadDeclarativeGroups()).toEqual([]);
  });
});
