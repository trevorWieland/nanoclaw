import { describe, it, expect, vi, beforeEach } from "vitest";

type NetIf = ReturnType<(typeof import("os"))["networkInterfaces"]>;

async function loadRuntime(opts: {
  envHost?: string;
  platform?: NodeJS.Platform;
  hasWslInterop?: boolean;
  ifaces?: NetIf;
}) {
  vi.resetModules();

  if (opts.envHost) process.env.CREDENTIAL_PROXY_HOST = opts.envHost;
  else delete process.env.CREDENTIAL_PROXY_HOST;

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  vi.doMock("./logger.js", () => ({ logger }));
  vi.doMock("os", async () => {
    const actual = await vi.importActual<typeof import("os")>("os");
    return {
      ...actual,
      default: {
        ...(actual as unknown as Record<string, unknown>),
        platform: () => opts.platform ?? "linux",
        networkInterfaces: () => opts.ifaces ?? {},
      },
      platform: () => opts.platform ?? "linux",
      networkInterfaces: () => opts.ifaces ?? {},
    };
  });
  vi.doMock("fs", async () => {
    const actual = await vi.importActual<typeof import("fs")>("fs");
    return {
      ...actual,
      default: {
        ...(actual as unknown as Record<string, unknown>),
        existsSync: () => opts.hasWslInterop ?? false,
      },
      existsSync: () => opts.hasWslInterop ?? false,
    };
  });

  const runtime = await import("./container-runtime.js");
  return { runtime, logger };
}

describe("PROXY_BIND_HOST", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CREDENTIAL_PROXY_HOST;
  });

  it("binds to docker0 IPv4 on Linux when available", async () => {
    const ifaces = {
      docker0: [
        { address: "172.17.0.1", family: "IPv4", internal: false, netmask: "", mac: "", cidr: "" },
      ],
    } as NetIf;
    const { runtime, logger } = await loadRuntime({ ifaces });

    expect(runtime.PROXY_BIND_HOST).toBe("172.17.0.1");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to loopback instead of 0.0.0.0 when docker0 is missing", async () => {
    const { runtime, logger } = await loadRuntime({ ifaces: {} as NetIf });

    expect(runtime.PROXY_BIND_HOST).toBe("127.0.0.1");
    expect(logger.warn).toHaveBeenCalledWith(
      "docker0 bridge not found; binding credential proxy to loopback for safety. Set CREDENTIAL_PROXY_HOST to override.",
    );
  });
});
