import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import {
  _resetAuthCircuitBreakerForTests,
  checkCircuit,
  isAuthError,
  recordAuthFailure,
  recordAuthSuccess,
} from "./auth-circuit-breaker.js";
import { logger } from "./logger.js";

beforeEach(() => {
  _resetAuthCircuitBreakerForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isAuthError", () => {
  it.each([
    "HTTP 401 Unauthorized",
    "unauthorized access",
    "authentication failed",
    "oauth token expired",
    "token expired for user",
    "invalid_grant",
    "access_denied by server",
  ])("matches pattern: %s", (text) => {
    expect(isAuthError(text)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAuthError("UNAUTHORIZED")).toBe(true);
    expect(isAuthError("Token Expired")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isAuthError("")).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isAuthError("connection refused")).toBe(false);
    expect(isAuthError("timeout exceeded")).toBe(false);
    expect(isAuthError("disk full")).toBe(false);
  });
});

describe("circuit breaker state machine", () => {
  it("starts closed (allowed)", () => {
    expect(checkCircuit()).toEqual({ allowed: true });
  });

  it("stays closed under threshold (< 3 failures)", () => {
    recordAuthFailure();
    recordAuthFailure();
    expect(checkCircuit().allowed).toBe(true);
  });

  it("opens after 3 consecutive failures", () => {
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    const result = checkCircuit();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("circuit breaker open");
  });

  it("recordAuthSuccess resets the circuit", () => {
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    expect(checkCircuit().allowed).toBe(false);

    recordAuthSuccess();
    expect(checkCircuit().allowed).toBe(true);
  });

  it("auto-resets after 15 minute timeout", () => {
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();
    expect(checkCircuit().allowed).toBe(false);

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(checkCircuit().allowed).toBe(true);
  });

  it("stays open before timeout expires", () => {
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();

    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(checkCircuit().allowed).toBe(false);
  });

  it("reason message includes failure count and remaining time", () => {
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();

    vi.advanceTimersByTime(5 * 60 * 1000); // 5 min elapsed
    const result = checkCircuit();
    expect(result.reason).toContain("3 consecutive failures");
    expect(result.reason).toContain("10 minutes");
  });
});

describe("circuit breaker audit events", () => {
  beforeEach(() => {
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.info).mockClear();
  });

  it("logs circuit_breaker_open event when circuit opens", () => {
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();

    const errorCalls = vi.mocked(logger.error).mock.calls;
    const openCall = errorCalls.find(
      (call) => typeof call[0] === "object" && (call[0] as any).event === "circuit_breaker_open",
    );
    expect(openCall).toBeDefined();
  });

  it("logs circuit_breaker_reset event on success after failure", () => {
    recordAuthFailure();
    recordAuthSuccess();

    const infoCalls = vi.mocked(logger.info).mock.calls;
    const resetCall = infoCalls.find(
      (call) => typeof call[0] === "object" && (call[0] as any).event === "circuit_breaker_reset",
    );
    expect(resetCall).toBeDefined();
  });

  it("logs circuit_breaker_auto_reset event after timeout", () => {
    recordAuthFailure();
    recordAuthFailure();
    recordAuthFailure();

    vi.advanceTimersByTime(15 * 60 * 1000);
    checkCircuit();

    const infoCalls = vi.mocked(logger.info).mock.calls;
    const autoResetCall = infoCalls.find(
      (call) =>
        typeof call[0] === "object" && (call[0] as any).event === "circuit_breaker_auto_reset",
    );
    expect(autoResetCall).toBeDefined();
  });
});
