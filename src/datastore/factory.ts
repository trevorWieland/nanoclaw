import type { DataStore } from "./types.js";

export interface DataStoreConfig {
  backend: "sqlite" | "postgres";
  url: string;
  assistantName: string;
}

export async function createDataStore(config: DataStoreConfig): Promise<DataStore> {
  if (config.backend === "postgres") {
    if (!config.url || !config.url.startsWith("postgres")) {
      const got = config.url || "(empty)";
      throw new Error(
        `DB_BACKEND=postgres requires DATABASE_URL to be a Postgres connection string (got "${got}"). ` +
          "Set DATABASE_URL=postgres://user:pass@host:5432/dbname in .env",
      );
    }
    const pgMod = await import("postgres");
    const postgres = pgMod.default;
    const { PostgresAdapter } = await import("./postgres-adapter.js");
    const sql = postgres(config.url);
    const adapter = new PostgresAdapter(sql);
    await adapter.runMigrations();
    return adapter;
  }

  // Default: SQLite
  const { default: Database } = await import("better-sqlite3");
  const { SqliteAdapter, createSqliteSchema } = await import("./sqlite-adapter.js");
  const fs = await import("fs");
  const path = await import("path");

  fs.mkdirSync(path.dirname(config.url), { recursive: true });
  const db = new Database(config.url);
  createSqliteSchema(db, config.assistantName);
  return new SqliteAdapter(db, config.assistantName);
}

export async function createTestDataStore(assistantName: string = "Andy"): Promise<DataStore> {
  const { default: Database } = await import("better-sqlite3");
  const { SqliteAdapter, createSqliteSchema } = await import("./sqlite-adapter.js");
  const db = new Database(":memory:");
  createSqliteSchema(db, assistantName);
  return new SqliteAdapter(db, assistantName);
}
