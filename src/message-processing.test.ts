import { describe, expect, it } from "vitest";

import { decideCursorAction } from "./message-processing.js";

const base = {
  hadError: false,
  hadSendError: false,
  outputSentToUser: false,
  truncated: false,
  isTailDrain: false,
  wasTailDrain: false,
};

describe("decideCursorAction", () => {
  // --- Error paths ---

  it("agent error + output sent -> no rollback", () => {
    const d = decideCursorAction({ ...base, hadError: true, outputSentToUser: true });
    expect(d.shouldRollback).toBe(false);
    expect(d.succeeded).toBe(true);
  });

  it("agent error + output sent + truncated -> enqueue continuation", () => {
    const d = decideCursorAction({
      ...base,
      hadError: true,
      outputSentToUser: true,
      truncated: true,
    });
    expect(d.shouldRollback).toBe(false);
    expect(d.shouldEnqueue).toBe(true);
  });

  it("agent error + no output -> rollback", () => {
    const d = decideCursorAction({ ...base, hadError: true });
    expect(d.shouldRollback).toBe(true);
    expect(d.succeeded).toBe(false);
  });

  it("agent error + isTailDrain -> rollback + persist tail drain", () => {
    const d = decideCursorAction({ ...base, hadError: true, isTailDrain: true });
    expect(d.shouldRollback).toBe(true);
    expect(d.shouldPersistTailDrain).toBe(true);
  });

  it("agent error + truncated + no output -> rollback + clear stale marker + persist", () => {
    const d = decideCursorAction({ ...base, hadError: true, truncated: true });
    expect(d.shouldRollback).toBe(true);
    expect(d.shouldClearTailDrain).toBe(true);
    expect(d.shouldPersistTailDrain).toBe(true);
  });

  it("agent error + isTailDrain + truncated -> rollback without clearing (isTailDrain takes priority)", () => {
    const d = decideCursorAction({
      ...base,
      hadError: true,
      isTailDrain: true,
      truncated: true,
    });
    expect(d.shouldRollback).toBe(true);
    expect(d.shouldClearTailDrain).toBe(false);
  });

  // --- Send error paths ---

  it("send error + no output -> rollback", () => {
    const d = decideCursorAction({ ...base, hadSendError: true });
    expect(d.shouldRollback).toBe(true);
    expect(d.succeeded).toBe(false);
  });

  it("send error + truncated + no output -> rollback + clear + persist", () => {
    const d = decideCursorAction({ ...base, hadSendError: true, truncated: true });
    expect(d.shouldRollback).toBe(true);
    expect(d.shouldClearTailDrain).toBe(true);
    expect(d.shouldPersistTailDrain).toBe(true);
  });

  it("send error + output sent -> no rollback", () => {
    const d = decideCursorAction({
      ...base,
      hadSendError: true,
      outputSentToUser: true,
    });
    expect(d.shouldRollback).toBe(false);
    expect(d.succeeded).toBe(true);
  });

  // --- Success paths ---

  it("success + truncated -> enqueue continuation", () => {
    const d = decideCursorAction({ ...base, truncated: true });
    expect(d.shouldRollback).toBe(false);
    expect(d.shouldEnqueue).toBe(true);
    expect(d.succeeded).toBe(true);
  });

  it("success + isTailDrain -> persist + enqueue", () => {
    const d = decideCursorAction({ ...base, isTailDrain: true });
    expect(d.shouldPersistTailDrain).toBe(true);
    expect(d.shouldEnqueue).toBe(true);
    expect(d.succeeded).toBe(true);
  });

  it("success + wasTailDrain -> persist (cleanup)", () => {
    const d = decideCursorAction({ ...base, wasTailDrain: true });
    expect(d.shouldPersistTailDrain).toBe(true);
    expect(d.shouldEnqueue).toBe(false);
    expect(d.succeeded).toBe(true);
  });

  it("success + clean -> no action", () => {
    const d = decideCursorAction({ ...base });
    expect(d.shouldRollback).toBe(false);
    expect(d.shouldEnqueue).toBe(false);
    expect(d.shouldPersistTailDrain).toBe(false);
    expect(d.shouldClearTailDrain).toBe(false);
    expect(d.succeeded).toBe(true);
  });
});
