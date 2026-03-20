/**
 * Zod schemas for all IPC message types between host and containers.
 *
 * Container→host schemas use .passthrough() — containers write metadata fields
 * (timestamp, createdBy, groupFolder, isMain) that the host ignores.
 * Host→container schemas use .strict() — extra fields indicate host bugs.
 *
 * @see docs/SECURITY.md#4-ipc-authorization
 */
import { z } from "zod";

// =========================================
// Container → Host: Messages directory
// =========================================

export const IpcMessageSchema = z
  .object({
    type: z.literal("message"),
    chatJid: z.string().min(1),
    text: z.string().min(1),
    sender: z.string().optional(),
  })
  .passthrough();

// =========================================
// Container → Host: Tasks directory
// (discriminated union on "type" field)
// =========================================

const ScheduleTaskSchema = z
  .object({
    type: z.literal("schedule_task"),
    taskId: z.string().optional(),
    prompt: z.string().min(1),
    schedule_type: z.enum(["cron", "interval", "once"]),
    schedule_value: z.string().min(1),
    context_mode: z.enum(["group", "isolated"]).optional(),
    targetJid: z.string().min(1),
  })
  .passthrough();

const PauseTaskSchema = z
  .object({
    type: z.literal("pause_task"),
    taskId: z.string().min(1),
  })
  .passthrough();

const ResumeTaskSchema = z
  .object({
    type: z.literal("resume_task"),
    taskId: z.string().min(1),
  })
  .passthrough();

const CancelTaskSchema = z
  .object({
    type: z.literal("cancel_task"),
    taskId: z.string().min(1),
  })
  .passthrough();

const UpdateTaskSchema = z
  .object({
    type: z.literal("update_task"),
    taskId: z.string().min(1),
    prompt: z.string().optional(),
    schedule_type: z.enum(["cron", "interval", "once"]).optional(),
    schedule_value: z.string().optional(),
  })
  .passthrough();

const RegisterGroupSchema = z
  .object({
    type: z.literal("register_group"),
    jid: z.string().min(1),
    name: z.string().min(1),
    folder: z.string().min(1),
    trigger: z.string().min(1),
    requiresTrigger: z.boolean().optional(),
    containerConfig: z
      .object({
        additionalMounts: z
          .array(
            z.object({
              hostPath: z.string(),
              containerPath: z.string().optional(),
              readonly: z.boolean().optional(),
            }),
          )
          .optional(),
        timeout: z.number().optional(),
        memoryLimit: z.string().optional(),
        cpuLimit: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

const RefreshGroupsSchema = z
  .object({
    type: z.literal("refresh_groups"),
  })
  .passthrough();

export const TaskIpcSchema = z.discriminatedUnion("type", [
  ScheduleTaskSchema,
  PauseTaskSchema,
  ResumeTaskSchema,
  CancelTaskSchema,
  UpdateTaskSchema,
  RegisterGroupSchema,
  RefreshGroupsSchema,
]);

export type TaskIpcMessage = z.infer<typeof TaskIpcSchema>;

// =========================================
// Container → Host: stdout output markers
// =========================================

export const ContainerOutputSchema = z
  .object({
    status: z.enum(["success", "error"]),
    result: z.string().nullable(),
    newSessionId: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type ContainerOutput = z.infer<typeof ContainerOutputSchema>;

// =========================================
// Host → Container: stdin JSON
// =========================================

export const ContainerInputSchema = z
  .object({
    prompt: z.string(),
    sessionId: z.string().optional(),
    groupFolder: z.string(),
    chatJid: z.string(),
    isMain: z.boolean(),
    isScheduledTask: z.boolean().optional(),
    assistantName: z.string().optional(),
    tanren: z
      .object({
        apiUrl: z.string(),
        apiKey: z.string(),
      })
      .optional(),
  })
  .strict();

export type ContainerInput = z.infer<typeof ContainerInputSchema>;

// =========================================
// Host → Container: follow-up message
// =========================================

export const FollowUpMessageSchema = z
  .object({
    type: z.literal("message"),
    text: z.string().min(1),
  })
  .strict();

// =========================================
// Host → Container: task snapshot
// =========================================

const TaskSnapshotEntrySchema = z.object({
  id: z.string(),
  groupFolder: z.string(),
  prompt: z.string(),
  schedule_type: z.string(),
  schedule_value: z.string(),
  status: z.string(),
  next_run: z.string().nullable(),
});

export const TaskSnapshotSchema = z.array(TaskSnapshotEntrySchema);

export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;

// =========================================
// Host → Container: groups snapshot
// =========================================

const AvailableGroupEntrySchema = z.object({
  jid: z.string(),
  name: z.string(),
  lastActivity: z.string(),
  isRegistered: z.boolean(),
});

export const GroupsSnapshotSchema = z
  .object({
    groups: z.array(AvailableGroupEntrySchema),
    lastSync: z.string(),
  })
  .strict();
