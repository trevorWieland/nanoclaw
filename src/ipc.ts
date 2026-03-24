/**
 * File-based IPC processing and authorization gate for container actions.
 * Docs map:
 * - docs/SPEC.md#mcp-servers
 * - docs/SPEC.md#scheduled-tasks
 * - docs/SECURITY.md#4-ipc-authorization
 * Fork-specific rationale:
 * - IPC actions are constrained by source-group identity before execution.
 */
import { mkdir, readdir, readFile, rename, stat, unlink } from "fs/promises";
import path from "path";

import { CronExpressionParser } from "cron-parser";

import { TIMEZONE } from "./config.js";
import { AvailableGroup } from "./container-runner.js";
import { createTask, deleteTask, getTaskById, updateTask } from "./db.js";
import { isValidGroupFolder } from "./group-folder.js";
import { IpcMessageSchema, TaskIpcSchema, type TaskIpcMessage } from "./ipc-schemas.js";
import { logger } from "./logger.js";
import { RegisteredGroup } from "./types.js";

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => Promise<void>;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => Promise<AvailableGroup[]>;
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void | Promise<void>;
}

/**
 * Process all pending IPC files in the given base directory.
 * Uses async I/O throughout to avoid blocking the event loop.
 */
export async function processIpcFiles(ipcBaseDir: string, deps: IpcDeps): Promise<void> {
  // Scan all group IPC directories (identity determined by directory)
  let entries: string[];
  try {
    entries = await readdir(ipcBaseDir);
  } catch (err) {
    logger.error({ err, ipcBaseDir }, "Error reading IPC base directory");
    return;
  }

  // Filter to directories, excluding errors/
  const groupFolders: string[] = [];
  for (const f of entries) {
    try {
      const s = await stat(path.join(ipcBaseDir, f));
      if (s.isDirectory() && f !== "errors") groupFolders.push(f);
    } catch {
      // Entry may have been removed between readdir and stat
    }
  }

  const registeredGroups = deps.registeredGroups();

  // Build folder->isMain lookup from registered groups
  const folderIsMain = new Map<string, boolean>();
  for (const group of Object.values(registeredGroups)) {
    if (group.isMain) folderIsMain.set(group.folder, true);
  }

  for (const sourceGroup of groupFolders) {
    const isMain = folderIsMain.get(sourceGroup) === true;
    const messagesDir = path.join(ipcBaseDir, sourceGroup, "messages");
    const tasksDir = path.join(ipcBaseDir, sourceGroup, "tasks");

    // Process messages from this group's IPC directory
    await processDirectory(
      ipcBaseDir,
      messagesDir,
      sourceGroup,
      isMain,
      deps,
      registeredGroups,
      "message",
    );

    // Process tasks from this group's IPC directory
    await processDirectory(
      ipcBaseDir,
      tasksDir,
      sourceGroup,
      isMain,
      deps,
      registeredGroups,
      "task",
    );
  }
}

async function processDirectory(
  ipcBaseDir: string,
  dir: string,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
  kind: "message" | "task",
): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    logger.error({ err, sourceGroup }, `Error reading IPC ${kind}s directory`);
    return;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const raw = JSON.parse(await readFile(filePath, "utf-8"));

      if (kind === "message") {
        const parsed = IpcMessageSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn(
            { file, sourceGroup, issues: parsed.error.issues },
            "IPC message failed schema validation",
          );
          await moveToErrors(ipcBaseDir, filePath, sourceGroup, file);
          continue;
        }
        const data = parsed.data;
        // Authorization: verify this group can send to this chatJid
        const targetGroup = registeredGroups[data.chatJid];
        if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
          await deps.sendMessage(data.chatJid, data.text);
          logger.info({ chatJid: data.chatJid, sourceGroup }, "IPC message sent");
        } else {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            "Unauthorized IPC message attempt blocked",
          );
        }
      } else {
        const parsed = TaskIpcSchema.safeParse(raw);
        if (!parsed.success) {
          logger.warn(
            { file, sourceGroup, issues: parsed.error.issues },
            "IPC task failed schema validation",
          );
          await moveToErrors(ipcBaseDir, filePath, sourceGroup, file);
          continue;
        }
        await processTaskIpc(parsed.data, sourceGroup, isMain, deps);
      }

      await unlink(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, `Error processing IPC ${kind}`);
      await moveToErrors(ipcBaseDir, filePath, sourceGroup, file);
    }
  }
}

async function moveToErrors(
  ipcBaseDir: string,
  filePath: string,
  sourceGroup: string,
  file: string,
): Promise<void> {
  try {
    const errorDir = path.join(ipcBaseDir, "errors");
    await mkdir(errorDir, { recursive: true });
    await rename(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
  } catch (moveErr) {
    logger.error({ moveErr, filePath }, "Failed to move IPC file to errors directory");
  }
}

export async function processTaskIpc(
  data: TaskIpcMessage,
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case "schedule_task": {
      // Resolve the target group from JID
      const targetGroupEntry = registeredGroups[data.targetJid];

      if (!targetGroupEntry) {
        logger.warn(
          { targetJid: data.targetJid },
          "Cannot schedule task: target group not registered",
        );
        break;
      }

      const targetFolder = targetGroupEntry.folder;

      // Authorization: non-main groups can only schedule for themselves
      if (!isMain && targetFolder !== sourceGroup) {
        logger.warn({ sourceGroup, targetFolder }, "Unauthorized schedule_task attempt blocked");
        break;
      }

      let nextRun: string | null = null;
      if (data.schedule_type === "cron") {
        try {
          const interval = CronExpressionParser.parse(data.schedule_value, {
            tz: TIMEZONE,
          });
          nextRun = interval.next().toISOString();
        } catch {
          logger.warn({ scheduleValue: data.schedule_value }, "Invalid cron expression");
          break;
        }
      } else if (data.schedule_type === "interval") {
        const ms = parseInt(data.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          logger.warn({ scheduleValue: data.schedule_value }, "Invalid interval");
          break;
        }
        nextRun = new Date(Date.now() + ms).toISOString();
      } else if (data.schedule_type === "once") {
        const date = new Date(data.schedule_value);
        if (isNaN(date.getTime())) {
          logger.warn({ scheduleValue: data.schedule_value }, "Invalid timestamp");
          break;
        }
        nextRun = date.toISOString();
      }

      const taskId = data.taskId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const contextMode = data.context_mode ?? "isolated";
      await createTask({
        id: taskId,
        group_folder: targetFolder,
        chat_jid: data.targetJid,
        prompt: data.prompt,
        schedule_type: data.schedule_type,
        schedule_value: data.schedule_value,
        context_mode: contextMode,
        next_run: nextRun,
        status: "active",
        created_at: new Date().toISOString(),
      });
      logger.info({ taskId, sourceGroup, targetFolder, contextMode }, "Task created via IPC");
      await deps.onTasksChanged();
      break;
    }

    case "pause_task": {
      const task = await getTaskById(data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        await updateTask(data.taskId, { status: "paused" });
        logger.info({ taskId: data.taskId, sourceGroup }, "Task paused via IPC");
        await deps.onTasksChanged();
      } else {
        logger.warn({ taskId: data.taskId, sourceGroup }, "Unauthorized task pause attempt");
      }
      break;
    }

    case "resume_task": {
      const task = await getTaskById(data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        await updateTask(data.taskId, { status: "active" });
        logger.info({ taskId: data.taskId, sourceGroup }, "Task resumed via IPC");
        await deps.onTasksChanged();
      } else {
        logger.warn({ taskId: data.taskId, sourceGroup }, "Unauthorized task resume attempt");
      }
      break;
    }

    case "cancel_task": {
      const task = await getTaskById(data.taskId);
      if (task && (isMain || task.group_folder === sourceGroup)) {
        await deleteTask(data.taskId);
        logger.info({ taskId: data.taskId, sourceGroup }, "Task cancelled via IPC");
        await deps.onTasksChanged();
      } else {
        logger.warn({ taskId: data.taskId, sourceGroup }, "Unauthorized task cancel attempt");
      }
      break;
    }

    case "update_task": {
      const task = await getTaskById(data.taskId);
      if (!task) {
        logger.warn({ taskId: data.taskId, sourceGroup }, "Task not found for update");
        break;
      }
      if (!isMain && task.group_folder !== sourceGroup) {
        logger.warn({ taskId: data.taskId, sourceGroup }, "Unauthorized task update attempt");
        break;
      }

      const updates: Parameters<typeof updateTask>[1] = {};
      if (data.prompt !== undefined) updates.prompt = data.prompt;
      if (data.schedule_type !== undefined) updates.schedule_type = data.schedule_type;
      if (data.schedule_value !== undefined) updates.schedule_value = data.schedule_value;

      // Recompute next_run if schedule changed
      if (data.schedule_type || data.schedule_value) {
        const updatedTask = {
          ...task,
          ...updates,
        };
        if (updatedTask.schedule_type === "cron") {
          try {
            const interval = CronExpressionParser.parse(updatedTask.schedule_value, {
              tz: TIMEZONE,
            });
            updates.next_run = interval.next().toISOString();
          } catch {
            logger.warn(
              { taskId: data.taskId, value: updatedTask.schedule_value },
              "Invalid cron in task update",
            );
            break;
          }
        } else if (updatedTask.schedule_type === "interval") {
          const ms = parseInt(updatedTask.schedule_value, 10);
          if (!isNaN(ms) && ms > 0) {
            updates.next_run = new Date(Date.now() + ms).toISOString();
          }
        }
      }

      await updateTask(data.taskId, updates);
      logger.info({ taskId: data.taskId, sourceGroup, updates }, "Task updated via IPC");
      await deps.onTasksChanged();
      break;
    }

    case "refresh_groups":
      // Only main group can request a refresh
      if (isMain) {
        logger.info({ sourceGroup }, "Group metadata refresh requested via IPC");
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = await deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn({ sourceGroup }, "Unauthorized refresh_groups attempt blocked");
      }
      break;

    case "register_group":
      // Only main group can register new groups
      if (!isMain) {
        logger.warn({ sourceGroup }, "Unauthorized register_group attempt blocked");
        break;
      }
      if (!isValidGroupFolder(data.folder)) {
        logger.warn(
          { sourceGroup, folder: data.folder },
          "Invalid register_group request - unsafe folder name",
        );
        break;
      }
      // Defense in depth: agent cannot set isMain via IPC
      await deps.registerGroup(data.jid, {
        name: data.name,
        folder: data.folder,
        trigger: data.trigger,
        added_at: new Date().toISOString(),
        containerConfig: data.containerConfig,
        requiresTrigger: data.requiresTrigger,
      });
      break;
  }
}
