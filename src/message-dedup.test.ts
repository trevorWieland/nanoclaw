import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetDedupForTests, fingerprint, recordSent, shouldSend } from "./message-dedup.js";

beforeEach(() => {
  _resetDedupForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fingerprint", () => {
  it("strips UUIDs", () => {
    const a = fingerprint("Error in 550e8400-e29b-41d4-a716-446655440000 handler");
    const b = fingerprint("Error in aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee handler");
    expect(a).toBe(b);
  });

  it("strips ISO timestamps", () => {
    const a = fingerprint("Failed at 2024-01-15T10:30:00.123Z");
    const b = fingerprint("Failed at 2025-06-22T18:00:00Z");
    expect(a).toBe(b);
  });

  it("strips request ID patterns", () => {
    const a = fingerprint("req_abc123def error");
    const b = fingerprint("req_xyz789ghi error");
    expect(a).toBe(b);
  });

  it("strips long hex strings", () => {
    const a = fingerprint("hash deadbeef01234567 mismatch");
    const b = fingerprint("hash aabbccdd99887766 mismatch");
    expect(a).toBe(b);
  });

  it("collapses whitespace", () => {
    const a = fingerprint("error   in    handler");
    const b = fingerprint("error in handler");
    expect(a).toBe(b);
  });

  it("is deterministic", () => {
    const msg = "Some error message";
    expect(fingerprint(msg)).toBe(fingerprint(msg));
  });

  it("different messages produce different hashes", () => {
    expect(fingerprint("connection refused")).not.toBe(fingerprint("timeout exceeded"));
  });
});

describe("shouldSend", () => {
  it("allows first occurrence", () => {
    expect(shouldSend("group-a", "hello")).toBe(true);
  });

  it("allows second occurrence (MAX_DUPLICATES=2)", () => {
    recordSent("group-a", "hello");
    expect(shouldSend("group-a", "hello")).toBe(true);
  });

  it("blocks third occurrence", () => {
    recordSent("group-a", "hello");
    recordSent("group-a", "hello");
    expect(shouldSend("group-a", "hello")).toBe(false);
  });

  it("resets after dedup window expires", () => {
    recordSent("group-a", "hello");
    recordSent("group-a", "hello");
    expect(shouldSend("group-a", "hello")).toBe(false);

    // Advance past the 5-minute window
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(shouldSend("group-a", "hello")).toBe(true);
  });

  it("isolates groups", () => {
    recordSent("group-a", "hello");
    recordSent("group-a", "hello");
    // group-b should still allow the same message
    expect(shouldSend("group-b", "hello")).toBe(true);
  });

  it("cleans up expired entries on check", () => {
    recordSent("group-a", "old message");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    // The expired entry should be cleaned up during shouldSend
    expect(shouldSend("group-a", "new message")).toBe(true);
  });
});

describe("recordSent", () => {
  it("increments count for existing entry", () => {
    recordSent("group-a", "msg");
    recordSent("group-a", "msg");
    // Third send should be blocked (count=2 >= MAX_DUPLICATES=2)
    expect(shouldSend("group-a", "msg")).toBe(false);
  });

  it("creates new entry for new message", () => {
    recordSent("group-a", "first");
    // New message should still be allowed
    expect(shouldSend("group-a", "second")).toBe(true);
  });

  it("resets entry after window expiry", () => {
    recordSent("group-a", "msg");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    recordSent("group-a", "msg");
    // After expiry, the count resets to 1, so second is still allowed
    expect(shouldSend("group-a", "msg")).toBe(true);
  });
});
