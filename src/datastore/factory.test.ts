import { describe, expect, it, vi } from "vitest";

import { createDataStore, createTestDataStore } from "./factory.js";

describe("createDataStore", () => {
  it("creates SQLite adapter for default backend", async () => {
    const store = await createDataStore({
      backend: "sqlite",
      url: ":memory:",
      assistantName: "Andy",
    });
    expect(store).toBeDefined();
    // Verify it has DataStore methods
    expect(typeof store.getNewMessages).toBe("function");
  });

  it("throws for postgres backend with empty URL", async () => {
    await expect(
      createDataStore({ backend: "postgres", url: "", assistantName: "Andy" }),
    ).rejects.toThrow("DB_BACKEND=postgres requires DATABASE_URL");
  });

  it("throws for postgres backend with non-postgres URL", async () => {
    await expect(
      createDataStore({
        backend: "postgres",
        url: "mysql://localhost/db",
        assistantName: "Andy",
      }),
    ).rejects.toThrow("DB_BACKEND=postgres requires DATABASE_URL");
  });
});

describe("createTestDataStore", () => {
  it("creates in-memory SQLite adapter", async () => {
    const store = await createTestDataStore("TestBot");
    expect(store).toBeDefined();
    expect(typeof store.getNewMessages).toBe("function");
  });

  it("uses default assistant name", async () => {
    const store = await createTestDataStore();
    expect(store).toBeDefined();
  });
});
