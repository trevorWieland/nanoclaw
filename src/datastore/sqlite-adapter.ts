import type Database from "better-sqlite3";

import { isValidGroupFolder } from "../group-folder.js";
import { logger } from "../logger.js";
import type { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from "../types.js";
import type { ChatInfo, DataStore } from "./types.js";

export class SqliteAdapter implements DataStore {
  constructor(
    private db: Database.Database,
    private assistantName: string,
  ) {}

  async close(): Promise<void> {
    this.db.close();
  }

  async storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void> {
    const ch = channel ?? null;
    const group = isGroup === undefined ? null : isGroup ? 1 : 0;

    if (name) {
      this.db
        .prepare(
          `
        INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          name = excluded.name,
          last_message_time = MAX(last_message_time, excluded.last_message_time),
          channel = COALESCE(excluded.channel, channel),
          is_group = COALESCE(excluded.is_group, is_group)
      `,
        )
        .run(chatJid, name, timestamp, ch, group);
    } else {
      this.db
        .prepare(
          `
        INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          last_message_time = MAX(last_message_time, excluded.last_message_time),
          channel = COALESCE(excluded.channel, channel),
          is_group = COALESCE(excluded.is_group, is_group)
      `,
        )
        .run(chatJid, chatJid, timestamp, ch, group);
    }
  }

  async getAllChats(): Promise<ChatInfo[]> {
    return this.db
      .prepare(
        `
      SELECT jid, name, last_message_time, channel, is_group
      FROM chats
      ORDER BY last_message_time DESC
    `,
      )
      .all() as ChatInfo[];
  }

  async storeMessage(msg: NewMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.chat_jid,
        msg.sender,
        msg.sender_name,
        msg.content,
        msg.timestamp,
        msg.is_from_me ? 1 : 0,
        msg.is_bot_message ? 1 : 0,
      );
  }

  async getNewMessages(
    jids: string[],
    lastTimestamp: string,
    botPrefix: string,
    limit: number = 200,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
    if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

    const placeholders = jids.map(() => "?").join(",");
    const sql = `
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
        FROM messages
        WHERE timestamp > ? AND chat_jid IN (${placeholders})
          AND is_bot_message = 0 AND content NOT LIKE ?
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?
      ) ORDER BY timestamp
    `;

    const rows = this.db
      .prepare(sql)
      .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

    let newTimestamp = lastTimestamp;
    for (const row of rows) {
      if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
    }

    return { messages: rows, newTimestamp };
  }

  async getMessagesSince(
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    limit: number = 200,
    sinceId?: string,
  ): Promise<NewMessage[]> {
    const tsOnlySql = `
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
        FROM messages
        WHERE chat_jid = ? AND timestamp > ?
          AND is_bot_message = 0 AND content NOT LIKE ?
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      ) ORDER BY timestamp, id
    `;
    const compositeSql = `
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
        FROM messages
        WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?))
          AND is_bot_message = 0 AND content NOT LIKE ?
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      ) ORDER BY timestamp, id
    `;
    const cursorId = sinceId || null;
    if (cursorId !== null) {
      return this.db
        .prepare(compositeSql)
        .all(
          chatJid,
          sinceTimestamp,
          sinceTimestamp,
          cursorId,
          `${botPrefix}:%`,
          limit,
        ) as NewMessage[];
    }
    return this.db
      .prepare(tsOnlySql)
      .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
  }

  async getAllMessagesSince(
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    batchSize: number = 200,
    sinceId?: string,
    maxRows?: number,
  ): Promise<NewMessage[]> {
    const initialSql = `
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp, id
      LIMIT ?
    `;
    const pageSql = `
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?))
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp, id
      LIMIT ?
    `;
    const initialStmt = this.db.prepare(initialSql);
    const pageStmt = this.db.prepare(pageSql);
    const all: NewMessage[] = [];
    let cursorTs = sinceTimestamp;
    let cursorId: string | null = sinceId || null;
    while (true) {
      const remaining = maxRows !== undefined ? maxRows - all.length : batchSize;
      if (remaining <= 0) break;
      const limit = maxRows !== undefined ? Math.min(batchSize, remaining) : batchSize;
      const batch: NewMessage[] =
        cursorId === null
          ? (initialStmt.all(chatJid, cursorTs, `${botPrefix}:%`, limit) as NewMessage[])
          : (pageStmt.all(
              chatJid,
              cursorTs,
              cursorTs,
              cursorId,
              `${botPrefix}:%`,
              limit,
            ) as NewMessage[]);
      if (batch.length === 0) break;
      all.push(...batch);
      const last = batch[batch.length - 1];
      cursorTs = last.timestamp;
      cursorId = last.id;
      if (batch.length < limit) break;
    }
    return all;
  }

  async createTask(task: Omit<ScheduledTask, "last_run" | "last_result">): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        task.id,
        task.group_folder,
        task.chat_jid,
        task.prompt,
        task.script || null,
        task.schedule_type,
        task.schedule_value,
        task.context_mode || "isolated",
        task.next_run,
        task.status,
        task.created_at,
      );
  }

  async getTaskById(id: string): Promise<ScheduledTask | undefined> {
    return this.db.prepare("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as
      | ScheduledTask
      | undefined;
  }

  async getAllTasks(): Promise<ScheduledTask[]> {
    return this.db
      .prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC")
      .all() as ScheduledTask[];
  }

  async updateTask(
    id: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        "prompt" | "script" | "schedule_type" | "schedule_value" | "next_run" | "status"
      >
    >,
  ): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.prompt !== undefined) {
      fields.push("prompt = ?");
      values.push(updates.prompt);
    }
    if (updates.script !== undefined) {
      fields.push("script = ?");
      values.push(updates.script || null);
    }
    if (updates.schedule_type !== undefined) {
      fields.push("schedule_type = ?");
      values.push(updates.schedule_type);
    }
    if (updates.schedule_value !== undefined) {
      fields.push("schedule_value = ?");
      values.push(updates.schedule_value);
    }
    if (updates.next_run !== undefined) {
      fields.push("next_run = ?");
      values.push(updates.next_run);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      values.push(updates.status);
    }

    if (fields.length === 0) return;

    values.push(id);
    this.db.prepare(`UPDATE scheduled_tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  async deleteTask(id: string): Promise<void> {
    const del = this.db.transaction(() => {
      this.db.prepare("DELETE FROM task_run_logs WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM scheduled_tasks WHERE id = ?").run(id);
    });
    del();
  }

  async getDueTasks(): Promise<ScheduledTask[]> {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run
    `,
      )
      .all(now) as ScheduledTask[];
  }

  async updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE scheduled_tasks
      SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
      WHERE id = ?
    `,
      )
      .run(nextRun, now, lastResult, nextRun, id);
  }

  async logTaskRun(log: TaskRunLog): Promise<void> {
    this.db
      .prepare(
        `
      INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
  }

  async getRouterState(key: string): Promise<string | undefined> {
    const row = this.db.prepare("SELECT value FROM router_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  async setRouterState(key: string, value: string): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  async setSession(groupFolder: string, sessionId: string): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)")
      .run(groupFolder, sessionId);
  }

  async getAllSessions(): Promise<Record<string, string>> {
    const rows = this.db.prepare("SELECT group_folder, session_id FROM sessions").all() as Array<{
      group_folder: string;
      session_id: string;
    }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.group_folder] = row.session_id;
    }
    return result;
  }

  async getRegisteredGroup(jid: string): Promise<(RegisteredGroup & { jid: string }) | undefined> {
    const row = this.db.prepare("SELECT * FROM registered_groups WHERE jid = ?").get(jid) as
      | {
          jid: string;
          name: string;
          folder: string;
          trigger_pattern: string;
          added_at: string;
          container_config: string | null;
          requires_trigger: number | null;
          is_main: number | null;
        }
      | undefined;
    if (!row) return undefined;
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        "Skipping registered group with invalid folder",
      );
      return undefined;
    }
    return {
      jid: row.jid,
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config ? JSON.parse(row.container_config) : undefined,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }

  async setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
    if (!isValidGroupFolder(group.folder)) {
      throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jid,
        group.name,
        group.folder,
        group.trigger,
        group.added_at,
        group.containerConfig ? JSON.stringify(group.containerConfig) : null,
        group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
        group.isMain ? 1 : 0,
      );
  }

  async getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
    const rows = this.db.prepare("SELECT * FROM registered_groups").all() as Array<{
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      added_at: string;
      container_config: string | null;
      requires_trigger: number | null;
      is_main: number | null;
    }>;
    const result: Record<string, RegisteredGroup> = {};
    for (const row of rows) {
      if (!isValidGroupFolder(row.folder)) {
        logger.warn(
          { jid: row.jid, folder: row.folder },
          "Skipping registered group with invalid folder",
        );
        continue;
      }
      result[row.jid] = {
        name: row.name,
        folder: row.folder,
        trigger: row.trigger_pattern,
        added_at: row.added_at,
        containerConfig: row.container_config ? JSON.parse(row.container_config) : undefined,
        requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
        isMain: row.is_main === 1 ? true : undefined,
      };
    }
    return result;
  }

  async getRegisteredGroupCount(): Promise<number> {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM registered_groups").get() as {
      count: number;
    };
    return row.count;
  }
}

export function createSqliteSchema(database: Database.Database, assistantName: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_chat_ts_id ON messages(chat_jid, timestamp, id);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
  } catch {
    // Intentionally suppressed: SQLite lacks IF NOT EXISTS for ADD COLUMN
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    // Intentionally suppressed: SQLite lacks IF NOT EXISTS for ADD COLUMN
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`);
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${assistantName}:%`);
  } catch {
    // Intentionally suppressed: SQLite lacks IF NOT EXISTS for ADD COLUMN
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`);
    database.exec(`UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`);
  } catch {
    // Intentionally suppressed: SQLite lacks IF NOT EXISTS for ADD COLUMN
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`);
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(`UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`);
    database.exec(`UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`);
  } catch {
    // Intentionally suppressed: SQLite lacks IF NOT EXISTS for ADD COLUMN
  }
}
