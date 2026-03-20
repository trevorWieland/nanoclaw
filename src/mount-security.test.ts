import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pino", () => ({
  default: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

let tmpDir: string;

function allowlistPath(): string {
  return path.join(tmpDir, "mount-allowlist.json");
}

function writeAllowlist(data: unknown): void {
  fs.writeFileSync(allowlistPath(), JSON.stringify(data));
}

function createHostDir(name: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const mockContainerMode = vi.hoisted(() => ({
  CONTAINER_HOST_CONFIG_DIR: "",
  CONTAINER_HOST_DATA_DIR: "",
}));

vi.mock("./config.js", () => ({
  get MOUNT_ALLOWLIST_PATH() {
    return allowlistPath();
  },
  get CONTAINER_HOST_CONFIG_DIR() {
    return mockContainerMode.CONTAINER_HOST_CONFIG_DIR;
  },
  get CONTAINER_HOST_DATA_DIR() {
    return mockContainerMode.CONTAINER_HOST_DATA_DIR;
  },
}));

// Must import after mocks are set up
import {
  _resetMountSecurityForTests,
  loadMountAllowlist,
  validateAdditionalMounts,
  validateMount,
} from "./mount-security.js";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mount-sec-test-"));
  _resetMountSecurityForTests();
  mockContainerMode.CONTAINER_HOST_CONFIG_DIR = "";
  mockContainerMode.CONTAINER_HOST_DATA_DIR = "";
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadMountAllowlist", () => {
  it("returns null when file is missing", () => {
    expect(loadMountAllowlist()).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    fs.writeFileSync(allowlistPath(), "not json{");
    expect(loadMountAllowlist()).toBeNull();
  });

  it("returns null when allowedRoots is not an array", () => {
    writeAllowlist({
      allowedRoots: "not-array",
      blockedPatterns: [],
      nonMainReadOnly: true,
    });
    expect(loadMountAllowlist()).toBeNull();
  });

  it("returns null when blockedPatterns is not an array", () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: "not-array",
      nonMainReadOnly: true,
    });
    expect(loadMountAllowlist()).toBeNull();
  });

  it("returns null when nonMainReadOnly is not a boolean", () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: "yes",
    });
    expect(loadMountAllowlist()).toBeNull();
  });

  it("loads valid allowlist and caches it", () => {
    writeAllowlist({
      allowedRoots: [{ path: "/tmp", allowReadWrite: true }],
      blockedPatterns: ["custom-blocked"],
      nonMainReadOnly: false,
    });

    const result = loadMountAllowlist();
    expect(result).not.toBeNull();
    expect(result!.allowedRoots).toHaveLength(1);
    // Returns same cached result on second call
    expect(loadMountAllowlist()).toBe(result);
  });

  it("merges default blocked patterns with user patterns", () => {
    writeAllowlist({
      allowedRoots: [],
      blockedPatterns: ["my-pattern"],
      nonMainReadOnly: true,
    });

    const result = loadMountAllowlist();
    expect(result!.blockedPatterns).toContain(".ssh");
    expect(result!.blockedPatterns).toContain(".env");
    expect(result!.blockedPatterns).toContain("my-pattern");
  });
});

describe("validateMount", () => {
  it("blocks all mounts when no allowlist exists", () => {
    const result = validateMount({ hostPath: "/tmp/test" }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("No mount allowlist");
  });

  it("rejects whitespace-only container path", () => {
    const hostDir = createHostDir("projects");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: hostDir, containerPath: "   " }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");
  });

  it("derives containerPath from basename when containerPath is empty", () => {
    const hostDir = createHostDir("projects");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: hostDir, containerPath: "" }, true);
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe("projects");
  });

  it("rejects absolute container path", () => {
    const hostDir = createHostDir("projects");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: hostDir, containerPath: "/etc/passwd" }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");
  });

  it("rejects container path with ..", () => {
    const hostDir = createHostDir("projects");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: hostDir, containerPath: "../escape" }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Invalid container path");
  });

  it("rejects nonexistent host path", () => {
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: path.join(tmpDir, "nope") }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("does not exist");
  });

  it("rejects path matching a blocked pattern", () => {
    const sshDir = createHostDir(".ssh");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: sshDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked pattern");
  });

  it("allows .credentials.json (does not substring-match 'credentials')", () => {
    const credsFile = createHostDir(".credentials.json");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: credsFile }, true);
    expect(result.allowed).toBe(true);
  });

  it("still blocks directories named 'credentials'", () => {
    const credsDir = createHostDir("credentials");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: credsDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked pattern");
  });

  it("blocks paths containing a blocked pattern (e.g., id_rsa.pub)", () => {
    const keyDir = createHostDir("id_rsa.pub");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: keyDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked pattern");
  });

  it("blocks mid-name substring match (e.g., my_private_key.pem)", () => {
    const keyDir = createHostDir("my_private_key.pem");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: keyDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked pattern");
  });

  it("blocks .env.local (substring match within dotfile)", () => {
    const envDir = createHostDir(".env.local");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: envDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked pattern");
  });

  it("rejects path not under any allowed root", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-test-"));
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: outsideDir }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not under any allowed root");

    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("allows valid mount under allowed root", () => {
    const hostDir = createHostDir("projects");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: hostDir }, true);
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(fs.realpathSync(hostDir));
    expect(result.resolvedContainerPath).toBe("projects");
  });

  it("derives containerPath from hostPath basename when not specified", () => {
    const hostDir = createHostDir("my-repo");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: hostDir }, true);
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe("my-repo");
  });
});

describe("readonly enforcement", () => {
  it("nonMainReadOnly forces readonly for non-main groups", () => {
    const hostDir = createHostDir("data");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const result = validateMount(
      { hostPath: hostDir, readonly: false },
      false, // isMain=false
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it("root allowReadWrite=false forces readonly", () => {
    const hostDir = createHostDir("data");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount(
      { hostPath: hostDir, readonly: false },
      true, // isMain=true
    );
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it("allows read-write when both root and group permit it", () => {
    const hostDir = createHostDir("data");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: hostDir, readonly: false }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });
});

describe("validateAdditionalMounts", () => {
  it("filters out rejected mounts", () => {
    const goodDir = createHostDir("good");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateAdditionalMounts(
      [{ hostPath: goodDir }, { hostPath: path.join(tmpDir, "nonexistent") }],
      "test-group",
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0].hostPath).toBe(fs.realpathSync(goodDir));
  });

  it("prefixes container paths with /workspace/extra/", () => {
    const hostDir = createHostDir("repo");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateAdditionalMounts([{ hostPath: hostDir }], "test-group", true);
    expect(result[0].containerPath).toBe("/workspace/extra/repo");
  });

  it("handles mixed valid and invalid mounts", () => {
    const goodDir1 = createHostDir("alpha");
    const goodDir2 = createHostDir("beta");
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateAdditionalMounts(
      [{ hostPath: goodDir1 }, { hostPath: "/definitely/not/real" }, { hostPath: goodDir2 }],
      "test-group",
      true,
    );
    expect(result).toHaveLength(2);
  });
});

describe("container mode validation", () => {
  it("skips existence check when in container mode", () => {
    mockContainerMode.CONTAINER_HOST_CONFIG_DIR = "/host/config";
    writeAllowlist({
      allowedRoots: [{ path: "/host/projects", allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    // Path doesn't exist locally, but should pass in container mode
    const result = validateMount({ hostPath: "/host/projects/my-repo" }, true);
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe("/host/projects/my-repo");
  });

  it("still rejects blocked patterns in container mode", () => {
    mockContainerMode.CONTAINER_HOST_CONFIG_DIR = "/host/config";
    writeAllowlist({
      allowedRoots: [{ path: "/host", allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: "/host/.ssh/keys" }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("blocked pattern");
  });

  it("still validates allowed roots in container mode", () => {
    mockContainerMode.CONTAINER_HOST_CONFIG_DIR = "/host/config";
    writeAllowlist({
      allowedRoots: [{ path: "/host/projects", allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: "/outside/projects/repo" }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not under any allowed root");
  });

  it("matches allowed roots by string prefix in container mode", () => {
    mockContainerMode.CONTAINER_HOST_DATA_DIR = "/host/data";
    writeAllowlist({
      allowedRoots: [{ path: "/host/projects", allowReadWrite: false }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: "/host/projects/deep/nested/repo" }, true);
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it("bare-metal mode still rejects nonexistent paths", () => {
    // No CONTAINER_HOST_* set — bare metal mode
    writeAllowlist({
      allowedRoots: [{ path: tmpDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: false,
    });

    const result = validateMount({ hostPath: path.join(tmpDir, "nonexistent") }, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("does not exist");
  });
});
