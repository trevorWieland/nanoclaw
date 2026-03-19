import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock container-only dependencies that aren't installed in the root project
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({ McpServer: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: vi.fn() }));
vi.mock("zod", () => ({
  z: {
    string: () => ({ describe: () => ({}), optional: () => ({ describe: () => ({}) }) }),
    number: () => ({ describe: () => ({}), optional: () => ({ describe: () => ({}) }) }),
  },
}));

import { TOOL_NAMES, tanrenFetch, ok, err } from "../src/tanren-mcp-stdio.js";

describe("tanren-mcp-stdio — tool definitions", () => {
  it("defines exactly 13 tools", () => {
    expect(TOOL_NAMES).toHaveLength(13);
  });

  it("all tool names start with tanren_", () => {
    for (const name of TOOL_NAMES) {
      expect(name).toMatch(/^tanren_/);
    }
  });
});

describe("tanren-mcp-stdio — tanrenFetch logic", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns parsed JSON on success", async () => {
    const body = { status: "ok", version: "0.1.0" };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    }) as unknown as typeof fetch;

    const result = await tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health");
    expect(result).toEqual(body);
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ detail: "unauthorized" }),
    }) as unknown as typeof fetch;

    await expect(tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health")).rejects.toThrow(
      "Tanren API 401",
    );
  });

  it("sends x-api-key header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await tanrenFetch("http://tanren:8000", "my-key", "GET", "/api/v1/health");

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-api-key"]).toBe("my-key");
  });

  it("sends Content-Type only when body is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // GET without body
    await tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health");
    expect(mockFetch.mock.calls[0][1].headers["Content-Type"]).toBeUndefined();

    // POST with body
    await tanrenFetch("http://tanren:8000", "key", "POST", "/api/v1/dispatch", { project: "p" });
    expect(mockFetch.mock.calls[1][1].headers["Content-Type"]).toBe("application/json");
  });

  it("returns raw text when response is not JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "plain text response",
    }) as unknown as typeof fetch;

    const result = await tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health");
    expect(result).toBe("plain text response");
  });

  it("includes error body in thrown error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: "internal server error" }),
    }) as unknown as typeof fetch;

    await expect(tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health")).rejects.toThrow(
      "internal server error",
    );
  });
});

describe("tanren-mcp-stdio — tanrenFetch edge cases", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POST body is JSON-serialized", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const body = { project: "my/repo", phase: "do-task" };
    await tanrenFetch("http://tanren:8000", "key", "POST", "/api/v1/dispatch", body);

    expect(mockFetch.mock.calls[0][1].body).toBe(JSON.stringify(body));
  });

  it("non-JSON error body is included in error message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    }) as unknown as typeof fetch;

    await expect(tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health")).rejects.toThrow(
      "Bad Gateway",
    );
  });

  it("uses AbortSignal.timeout", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "{}",
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await tanrenFetch("http://tanren:8000", "key", "GET", "/api/v1/health");

    expect(mockFetch.mock.calls[0][1].signal).toBeDefined();
  });
});

describe("tanren-mcp-stdio — tool response format", () => {
  it("ok() wraps data as JSON text content", () => {
    const result = ok({ status: "healthy" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ status: "healthy" });
  });

  it("err() wraps error message with isError flag", () => {
    const result = err(new Error("connection refused"));
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("connection refused");
    expect(result.isError).toBe(true);
  });

  it("err() handles string errors", () => {
    const result = err("something went wrong");
    expect(result.content[0].text).toBe("something went wrong");
    expect(result.isError).toBe(true);
  });

  it("ok() pretty-prints with 2-space indent", () => {
    const result = ok({ a: 1 });
    expect(result.content[0].text).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("err() handles non-Error non-string values", () => {
    const result = err(42);
    expect(result.content[0].text).toBe("42");
    expect(result.isError).toBe(true);
  });

  it("TOOL_NAMES contains all expected tools", () => {
    const expected = [
      "tanren_health",
      "tanren_dispatch",
      "tanren_dispatch_status",
      "tanren_cancel",
      "tanren_provision",
      "tanren_execute",
      "tanren_teardown",
      "tanren_run_full",
      "tanren_run_status",
      "tanren_vm_list",
      "tanren_vm_release",
      "tanren_config",
      "tanren_events",
    ];
    expect(TOOL_NAMES).toEqual(expected);
  });
});
