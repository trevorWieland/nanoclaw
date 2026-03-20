import { ASSISTANT_NAME, DATABASE_URL, DB_BACKEND } from "./config.js";
import { createDataStore, createTestDataStore } from "./datastore/index.js";
import type { ChatInfo, DataStore } from "./datastore/index.js";
import type { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from "./types.js";

let store: DataStore;

export async function initDatabase(): Promise<void> {
  store = await createDataStore({
    backend: DB_BACKEND,
    url: DATABASE_URL,
    assistantName: ASSISTANT_NAME,
  });
}

/** Close the DataStore connection. Used by setup CLI scripts for clean exit. */
export async function closeDatabase(): Promise<void> {
  if (store) await store.close();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export async function _initTestDatabase(): Promise<void> {
  store = await createTestDataStore(ASSISTANT_NAME);
}

export async function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): Promise<void> {
  return store.storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
}

export async function getAllChats(): Promise<ChatInfo[]> {
  return store.getAllChats();
}

export async function storeMessage(msg: NewMessage): Promise<void> {
  return store.storeMessage(msg);
}

export async function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit?: number,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  return store.getNewMessages(jids, lastTimestamp, botPrefix, limit);
}

export async function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit?: number,
  sinceId?: string,
): Promise<NewMessage[]> {
  return store.getMessagesSince(chatJid, sinceTimestamp, botPrefix, limit, sinceId);
}

export async function getAllMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  batchSize?: number,
  sinceId?: string,
  maxRows?: number,
): Promise<NewMessage[]> {
  return store.getAllMessagesSince(chatJid, sinceTimestamp, botPrefix, batchSize, sinceId, maxRows);
}

export async function createTask(
  task: Omit<ScheduledTask, "last_run" | "last_result">,
): Promise<void> {
  return store.createTask(task);
}

export async function getTaskById(id: string): Promise<ScheduledTask | undefined> {
  return store.getTaskById(id);
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  return store.getAllTasks();
}

export async function updateTask(
  id: string,
  updates: Partial<
    Pick<ScheduledTask, "prompt" | "schedule_type" | "schedule_value" | "next_run" | "status">
  >,
): Promise<void> {
  return store.updateTask(id, updates);
}

export async function deleteTask(id: string): Promise<void> {
  return store.deleteTask(id);
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  return store.getDueTasks();
}

export async function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  return store.updateTaskAfterRun(id, nextRun, lastResult);
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  return store.logTaskRun(log);
}

export async function getRouterState(key: string): Promise<string | undefined> {
  return store.getRouterState(key);
}

export async function setRouterState(key: string, value: string): Promise<void> {
  return store.setRouterState(key, value);
}

export async function setSession(groupFolder: string, sessionId: string): Promise<void> {
  return store.setSession(groupFolder, sessionId);
}

export async function getAllSessions(): Promise<Record<string, string>> {
  return store.getAllSessions();
}

export async function getRegisteredGroup(
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | undefined> {
  return store.getRegisteredGroup(jid);
}

export async function setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
  return store.setRegisteredGroup(jid, group);
}

export async function getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
  return store.getAllRegisteredGroups();
}

export async function getRegisteredGroupCount(): Promise<number> {
  return store.getRegisteredGroupCount();
}
