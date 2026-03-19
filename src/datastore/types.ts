import type { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from "../types.js";

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string | null;
  is_group: number | null;
}

export interface DataStore {
  close(): Promise<void>;

  // Chat metadata
  storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void>;
  getAllChats(): Promise<ChatInfo[]>;

  // Messages
  storeMessage(msg: NewMessage): Promise<void>;
  getNewMessages(
    jids: string[],
    lastTimestamp: string,
    botPrefix: string,
    limit?: number,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }>;
  getMessagesSince(
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    limit?: number,
    sinceId?: string,
  ): Promise<NewMessage[]>;
  getAllMessagesSince(
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    batchSize?: number,
    sinceId?: string,
    maxRows?: number,
  ): Promise<NewMessage[]>;

  // Tasks
  createTask(task: Omit<ScheduledTask, "last_run" | "last_result">): Promise<void>;
  getTaskById(id: string): Promise<ScheduledTask | undefined>;
  getAllTasks(): Promise<ScheduledTask[]>;
  updateTask(
    id: string,
    updates: Partial<
      Pick<ScheduledTask, "prompt" | "schedule_type" | "schedule_value" | "next_run" | "status">
    >,
  ): Promise<void>;
  deleteTask(id: string): Promise<void>;
  getDueTasks(): Promise<ScheduledTask[]>;
  updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): Promise<void>;
  logTaskRun(log: TaskRunLog): Promise<void>;

  // Router state
  getRouterState(key: string): Promise<string | undefined>;
  setRouterState(key: string, value: string): Promise<void>;

  // Sessions
  setSession(groupFolder: string, sessionId: string): Promise<void>;
  getAllSessions(): Promise<Record<string, string>>;

  // Registered groups
  getRegisteredGroup(jid: string): Promise<(RegisteredGroup & { jid: string }) | undefined>;
  setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void>;
  getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>>;

  // Setup helpers
  getRegisteredGroupCount(): Promise<number>;
}
