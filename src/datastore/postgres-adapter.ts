import type postgres from "postgres";

import { isValidGroupFolder } from "../group-folder.js";
import { logger } from "../logger.js";
import type { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from "../types.js";
import type { ChatInfo, DataStore } from "./types.js";

interface Migration {
  version: number;
  up: (sql: postgres.Sql) => Promise<void>;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: async (sql) => {
      await sql`
        CREATE TABLE IF NOT EXISTS chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT,
          channel TEXT,
          is_group BOOLEAN DEFAULT FALSE
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT,
          chat_jid TEXT,
          sender TEXT,
          sender_name TEXT,
          content TEXT,
          timestamp TEXT,
          is_from_me BOOLEAN,
          is_bot_message BOOLEAN DEFAULT FALSE,
          PRIMARY KEY (id, chat_jid),
          FOREIGN KEY (chat_jid) REFERENCES chats(jid)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_chat_ts_id ON messages(chat_jid, timestamp, id)`;

      await sql`
        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id TEXT PRIMARY KEY,
          group_folder TEXT NOT NULL,
          chat_jid TEXT NOT NULL,
          prompt TEXT NOT NULL,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          context_mode TEXT DEFAULT 'isolated',
          next_run TEXT,
          last_run TEXT,
          last_result TEXT,
          status TEXT DEFAULT 'active',
          created_at TEXT NOT NULL
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status)`;

      await sql`
        CREATE TABLE IF NOT EXISTS task_run_logs (
          id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          task_id TEXT NOT NULL,
          run_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          result TEXT,
          error TEXT,
          FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at)`;

      await sql`
        CREATE TABLE IF NOT EXISTS router_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS sessions (
          group_folder TEXT PRIMARY KEY,
          session_id TEXT NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS registered_groups (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL UNIQUE,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger BOOLEAN DEFAULT TRUE,
          is_main BOOLEAN DEFAULT FALSE
        )
      `;
    },
  },
];

export class PostgresAdapter implements DataStore {
  constructor(private sql: postgres.Sql) {}

  async runMigrations(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL
      )
    `;
    const rows = await this.sql<{ version: number }[]>`SELECT version FROM schema_version`;
    const current = rows.length > 0 ? rows[0].version : 0;

    for (const migration of MIGRATIONS) {
      if (migration.version > current) {
        await migration.up(this.sql);
        if (current === 0) {
          await this.sql`INSERT INTO schema_version (version) VALUES (${migration.version})`;
        } else {
          await this.sql`UPDATE schema_version SET version = ${migration.version}`;
        }
        logger.info({ version: migration.version }, "Postgres migration applied");
      }
    }
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void> {
    const ch = channel ?? null;
    const group = isGroup === undefined ? null : isGroup;

    if (name) {
      await this.sql`
        INSERT INTO chats (jid, name, last_message_time, channel, is_group)
        VALUES (${chatJid}, ${name}, ${timestamp}, ${ch}, ${group})
        ON CONFLICT(jid) DO UPDATE SET
          name = EXCLUDED.name,
          last_message_time = GREATEST(chats.last_message_time, EXCLUDED.last_message_time),
          channel = COALESCE(EXCLUDED.channel, chats.channel),
          is_group = COALESCE(EXCLUDED.is_group, chats.is_group)
      `;
    } else {
      await this.sql`
        INSERT INTO chats (jid, name, last_message_time, channel, is_group)
        VALUES (${chatJid}, ${chatJid}, ${timestamp}, ${ch}, ${group})
        ON CONFLICT(jid) DO UPDATE SET
          last_message_time = GREATEST(chats.last_message_time, EXCLUDED.last_message_time),
          channel = COALESCE(EXCLUDED.channel, chats.channel),
          is_group = COALESCE(EXCLUDED.is_group, chats.is_group)
      `;
    }
  }

  async getAllChats(): Promise<ChatInfo[]> {
    const rows = await this.sql<ChatInfo[]>`
      SELECT jid, name, last_message_time, channel,
        CASE WHEN is_group THEN 1 ELSE 0 END as is_group
      FROM chats
      ORDER BY last_message_time DESC
    `;
    return rows;
  }

  async storeMessage(msg: NewMessage): Promise<void> {
    await this.sql`
      INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
      VALUES (${msg.id}, ${msg.chat_jid}, ${msg.sender}, ${msg.sender_name}, ${msg.content}, ${msg.timestamp}, ${!!msg.is_from_me}, ${!!msg.is_bot_message})
      ON CONFLICT(id, chat_jid) DO UPDATE SET
        sender = EXCLUDED.sender,
        sender_name = EXCLUDED.sender_name,
        content = EXCLUDED.content,
        timestamp = EXCLUDED.timestamp,
        is_from_me = EXCLUDED.is_from_me,
        is_bot_message = EXCLUDED.is_bot_message
    `;
  }

  async getNewMessages(
    jids: string[],
    lastTimestamp: string,
    botPrefix: string,
    limit: number = 200,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
    if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

    const prefix = `${botPrefix}:%`;
    const rows = await this.sql<NewMessage[]>`
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp,
          CASE WHEN is_from_me THEN 1 ELSE 0 END as is_from_me
        FROM messages
        WHERE timestamp > ${lastTimestamp} AND chat_jid = ANY(${jids})
          AND is_bot_message = FALSE AND content NOT LIKE ${prefix}
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ${limit}
      ) sub ORDER BY timestamp
    `;

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
    const prefix = `${botPrefix}:%`;
    const cursorId = sinceId || null;

    if (cursorId !== null) {
      return this.sql<NewMessage[]>`
        SELECT * FROM (
          SELECT id, chat_jid, sender, sender_name, content, timestamp,
            CASE WHEN is_from_me THEN 1 ELSE 0 END as is_from_me
          FROM messages
          WHERE chat_jid = ${chatJid} AND (timestamp > ${sinceTimestamp} OR (timestamp = ${sinceTimestamp} AND id > ${cursorId}))
            AND is_bot_message = FALSE AND content NOT LIKE ${prefix}
            AND content != '' AND content IS NOT NULL
          ORDER BY timestamp DESC, id DESC
          LIMIT ${limit}
        ) sub ORDER BY timestamp, id
      `;
    }
    return this.sql<NewMessage[]>`
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp,
          CASE WHEN is_from_me THEN 1 ELSE 0 END as is_from_me
        FROM messages
        WHERE chat_jid = ${chatJid} AND timestamp > ${sinceTimestamp}
          AND is_bot_message = FALSE AND content NOT LIKE ${prefix}
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC, id DESC
        LIMIT ${limit}
      ) sub ORDER BY timestamp, id
    `;
  }

  async getAllMessagesSince(
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    batchSize: number = 200,
    sinceId?: string,
    maxRows?: number,
  ): Promise<NewMessage[]> {
    const prefix = `${botPrefix}:%`;
    const all: NewMessage[] = [];
    let cursorTs = sinceTimestamp;
    let cursorId: string | null = sinceId || null;

    while (true) {
      const remaining = maxRows !== undefined ? maxRows - all.length : batchSize;
      if (remaining <= 0) break;
      const limit = maxRows !== undefined ? Math.min(batchSize, remaining) : batchSize;

      let batch: NewMessage[];
      if (cursorId === null) {
        batch = await this.sql<NewMessage[]>`
          SELECT id, chat_jid, sender, sender_name, content, timestamp,
            CASE WHEN is_from_me THEN 1 ELSE 0 END as is_from_me
          FROM messages
          WHERE chat_jid = ${chatJid} AND timestamp > ${cursorTs}
            AND is_bot_message = FALSE AND content NOT LIKE ${prefix}
            AND content != '' AND content IS NOT NULL
          ORDER BY timestamp, id
          LIMIT ${limit}
        `;
      } else {
        batch = await this.sql<NewMessage[]>`
          SELECT id, chat_jid, sender, sender_name, content, timestamp,
            CASE WHEN is_from_me THEN 1 ELSE 0 END as is_from_me
          FROM messages
          WHERE chat_jid = ${chatJid} AND (timestamp > ${cursorTs} OR (timestamp = ${cursorTs} AND id > ${cursorId}))
            AND is_bot_message = FALSE AND content NOT LIKE ${prefix}
            AND content != '' AND content IS NOT NULL
          ORDER BY timestamp, id
          LIMIT ${limit}
        `;
      }
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
    await this.sql`
      INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
      VALUES (${task.id}, ${task.group_folder}, ${task.chat_jid}, ${task.prompt}, ${task.schedule_type}, ${task.schedule_value}, ${task.context_mode || "isolated"}, ${task.next_run}, ${task.status}, ${task.created_at})
    `;
  }

  async getTaskById(id: string): Promise<ScheduledTask | undefined> {
    const rows = await this.sql<ScheduledTask[]>`SELECT * FROM scheduled_tasks WHERE id = ${id}`;
    return rows[0];
  }

  async getAllTasks(): Promise<ScheduledTask[]> {
    return this.sql<ScheduledTask[]>`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`;
  }

  async updateTask(
    id: string,
    updates: Partial<
      Pick<ScheduledTask, "prompt" | "schedule_type" | "schedule_value" | "next_run" | "status">
    >,
  ): Promise<void> {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    let idx = 1;

    if (updates.prompt !== undefined) {
      sets.push(`prompt = $${idx++}`);
      values.push(updates.prompt);
    }
    if (updates.schedule_type !== undefined) {
      sets.push(`schedule_type = $${idx++}`);
      values.push(updates.schedule_type);
    }
    if (updates.schedule_value !== undefined) {
      sets.push(`schedule_value = $${idx++}`);
      values.push(updates.schedule_value);
    }
    if (updates.next_run !== undefined) {
      sets.push(`next_run = $${idx++}`);
      values.push(updates.next_run);
    }
    if (updates.status !== undefined) {
      sets.push(`status = $${idx++}`);
      values.push(updates.status);
    }

    if (sets.length === 0) return;

    // Use tagged template for dynamic updates
    await this.sql.unsafe(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = $${idx}`, [
      ...values,
      id,
    ]);
  }

  async deleteTask(id: string): Promise<void> {
    // Use unsafe() to work around tsgo not resolving TransactionSql template signatures
    await this.sql.begin(async (tx) => {
      await tx.unsafe("DELETE FROM task_run_logs WHERE task_id = $1", [id]);
      await tx.unsafe("DELETE FROM scheduled_tasks WHERE id = $1", [id]);
    });
  }

  async getDueTasks(): Promise<ScheduledTask[]> {
    const now = new Date().toISOString();
    return this.sql<ScheduledTask[]>`
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ${now}
      ORDER BY next_run
    `;
  }

  async updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): Promise<void> {
    const now = new Date().toISOString();
    await this.sql`
      UPDATE scheduled_tasks
      SET next_run = ${nextRun}, last_run = ${now}, last_result = ${lastResult},
        status = CASE WHEN ${nextRun}::text IS NULL THEN 'completed' ELSE status END
      WHERE id = ${id}
    `;
  }

  async logTaskRun(log: TaskRunLog): Promise<void> {
    await this.sql`
      INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
      VALUES (${log.task_id}, ${log.run_at}, ${log.duration_ms}, ${log.status}, ${log.result}, ${log.error})
    `;
  }

  async getRouterState(key: string): Promise<string | undefined> {
    const rows = await this.sql<
      { value: string }[]
    >`SELECT value FROM router_state WHERE key = ${key}`;
    return rows[0]?.value;
  }

  async setRouterState(key: string, value: string): Promise<void> {
    await this.sql`
      INSERT INTO router_state (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  async setSession(groupFolder: string, sessionId: string): Promise<void> {
    await this.sql`
      INSERT INTO sessions (group_folder, session_id) VALUES (${groupFolder}, ${sessionId})
      ON CONFLICT(group_folder) DO UPDATE SET session_id = EXCLUDED.session_id
    `;
  }

  async getAllSessions(): Promise<Record<string, string>> {
    const rows = await this.sql<{ group_folder: string; session_id: string }[]>`
      SELECT group_folder, session_id FROM sessions
    `;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.group_folder] = row.session_id;
    }
    return result;
  }

  async getRegisteredGroup(jid: string): Promise<(RegisteredGroup & { jid: string }) | undefined> {
    const rows = await this.sql<
      Array<{
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: boolean | null;
        is_main: boolean | null;
      }>
    >`SELECT * FROM registered_groups WHERE jid = ${jid}`;
    const row = rows[0];
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
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === true,
      isMain: row.is_main === true ? true : undefined,
    };
  }

  async setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
    if (!isValidGroupFolder(group.folder)) {
      throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
    }
    const containerConfig = group.containerConfig ? JSON.stringify(group.containerConfig) : null;
    const requiresTrigger = group.requiresTrigger === undefined ? true : group.requiresTrigger;
    const isMain = !!group.isMain;

    await this.sql`
      INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
      VALUES (${jid}, ${group.name}, ${group.folder}, ${group.trigger}, ${group.added_at}, ${containerConfig}, ${requiresTrigger}, ${isMain})
      ON CONFLICT(jid) DO UPDATE SET
        name = EXCLUDED.name,
        folder = EXCLUDED.folder,
        trigger_pattern = EXCLUDED.trigger_pattern,
        added_at = EXCLUDED.added_at,
        container_config = EXCLUDED.container_config,
        requires_trigger = EXCLUDED.requires_trigger,
        is_main = EXCLUDED.is_main
    `;
  }

  async getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
    const rows = await this.sql<
      Array<{
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: boolean | null;
        is_main: boolean | null;
      }>
    >`SELECT * FROM registered_groups`;
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
        requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === true,
        isMain: row.is_main === true ? true : undefined,
      };
    }
    return result;
  }

  async getRegisteredGroupCount(): Promise<number> {
    const rows = await this.sql<
      { count: string }[]
    >`SELECT COUNT(*) as count FROM registered_groups`;
    return Number(rows[0].count);
  }
}
