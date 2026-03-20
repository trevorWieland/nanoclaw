/**
 * Declarative group registration from a JSON config file.
 * Enables pre-populating groups in container deployments without IPC or setup CLI.
 */
import fs from "fs";
import path from "path";

import { isValidGroupFolder } from "./group-folder.js";
import { logger } from "./logger.js";
import { CONFIG_ROOT } from "./runtime-paths.js";
import type { RegisteredGroup } from "./types.js";

function registeredGroupsFile(): string {
  return path.join(CONFIG_ROOT, "registered-groups.json");
}

interface DeclarativeGroupEntry {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  containerConfig?: RegisteredGroup["containerConfig"];
}

function isValidEntry(entry: unknown): entry is DeclarativeGroupEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.jid === "string" &&
    typeof e.name === "string" &&
    typeof e.folder === "string" &&
    typeof e.trigger === "string"
  );
}

export function loadDeclarativeGroups(): Array<{ jid: string; group: RegisteredGroup }> {
  let raw: string;
  try {
    raw = fs.readFileSync(registeredGroupsFile(), "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    logger.warn({ err, path: registeredGroupsFile() }, "declarative-groups: cannot read config");
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn({ path: registeredGroupsFile() }, "declarative-groups: invalid JSON");
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn({ path: registeredGroupsFile() }, "declarative-groups: expected array");
    return [];
  }

  const results: Array<{ jid: string; group: RegisteredGroup }> = [];

  for (const entry of parsed) {
    if (!isValidEntry(entry)) {
      logger.warn({ entry }, "declarative-groups: skipping invalid entry");
      continue;
    }

    if (!isValidGroupFolder(entry.folder)) {
      logger.warn(
        { folder: entry.folder },
        "declarative-groups: skipping entry with invalid folder",
      );
      continue;
    }

    results.push({
      jid: entry.jid,
      group: {
        name: entry.name,
        folder: entry.folder,
        trigger: entry.trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: entry.requiresTrigger,
        isMain: entry.isMain,
        containerConfig: entry.containerConfig,
      },
    });
  }

  if (results.length > 0) {
    logger.info(
      { count: results.length, path: registeredGroupsFile() },
      "Loaded declarative group registrations",
    );
  }

  return results;
}
