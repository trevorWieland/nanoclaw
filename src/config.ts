/**
 * Central runtime constants and path/security defaults.
 * Docs map:
 * - docs/SPEC.md#configuration
 * - docs/SECURITY.md#2-mount-security
 * - docs/FORK_OVERVIEW.md
 */
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { readEnvFile } from "./env.js";
import { CONFIG_ROOT, PROJECT_ROOT } from "./runtime-paths.js";

// Re-export path roots so existing consumers don't need import changes
export { APP_DIR, DATA_DIR } from "./runtime-paths.js";

export const INSTANCE_ID =
  process.env.NANOCLAW_INSTANCE_ID ||
  createHash("sha256").update(CONFIG_ROOT).digest("hex").slice(0, 8);

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  "AGENT_NETWORK",
  "ASSISTANT_NAME",
  "CHANNEL_CONNECT_TIMEOUT",
  "CONTAINER_HOST_CONFIG_DIR",
  "CONTAINER_HOST_DATA_DIR",
  "CONTAINER_IMAGE",
  "CONTAINER_TIMEOUT",
  "CONTAINER_MAX_OUTPUT_SIZE",
  "CREDENTIAL_PROXY_EXTERNAL_URL",
  "CREDENTIAL_PROXY_PORT",
  "STATUS_PORT",
  "STATUS_BIND_HOST",
  "DB_BACKEND",
  "DATABASE_URL",
  "IDLE_TIMEOUT",
  "MAX_CONCURRENT_CONTAINERS",
]);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || "Andy";
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts.
const HOME_DIR = process.env.HOME || os.homedir();

// Security allowlists: prefer CONFIG_ROOT, fall back to legacy ~/.config/nanoclaw/
function resolveConfigWithLegacy(filename: string): string {
  const configPath = path.join(CONFIG_ROOT, filename);
  if (fs.existsSync(configPath)) return configPath;
  const legacyPath = path.join(HOME_DIR, ".config", "nanoclaw", filename);
  if (fs.existsSync(legacyPath)) return legacyPath;
  return configPath;
}

export const MOUNT_ALLOWLIST_PATH = resolveConfigWithLegacy("mount-allowlist.json");
export const SENDER_ALLOWLIST_PATH = resolveConfigWithLegacy("sender-allowlist.json");

export const STORE_DIR = path.resolve(
  process.env.NANOCLAW_STORE_DIR || path.join(PROJECT_ROOT, "store"),
);
export const GROUPS_DIR = path.resolve(CONFIG_ROOT, "groups");

// Docker mount source overrides — when NanoClaw runs in a container,
// Docker -v sources must be host paths, not container-internal paths.
export const CONTAINER_HOST_CONFIG_DIR =
  process.env.CONTAINER_HOST_CONFIG_DIR || envConfig.CONTAINER_HOST_CONFIG_DIR || "";
export const CONTAINER_HOST_DATA_DIR =
  process.env.CONTAINER_HOST_DATA_DIR || envConfig.CONTAINER_HOST_DATA_DIR || "";

// Container networking — also supports .env fallback for bare-metal deployments.
export const AGENT_NETWORK = process.env.AGENT_NETWORK || envConfig.AGENT_NETWORK || "";
export const CREDENTIAL_PROXY_EXTERNAL_URL =
  process.env.CREDENTIAL_PROXY_EXTERNAL_URL || envConfig.CREDENTIAL_PROXY_EXTERNAL_URL || "";

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name] || envConfig[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid integer for ${name}: "${raw}"`);
  }
  return parsed;
}

export const CHANNEL_CONNECT_TIMEOUT = parseIntEnv("CHANNEL_CONNECT_TIMEOUT", 30000);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || envConfig.CONTAINER_IMAGE || "";
export const CONTAINER_TIMEOUT = parseIntEnv("CONTAINER_TIMEOUT", 1800000);
export const CONTAINER_MAX_OUTPUT_SIZE = parseIntEnv("CONTAINER_MAX_OUTPUT_SIZE", 10485760); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseIntEnv("CREDENTIAL_PROXY_PORT", 3001);
export const STATUS_PORT = parseIntEnv("STATUS_PORT", 3002);
export const STATUS_BIND_HOST =
  process.env.STATUS_BIND_HOST || envConfig.STATUS_BIND_HOST || "127.0.0.1";
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseIntEnv("IDLE_TIMEOUT", 1800000); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseIntEnv("MAX_CONCURRENT_CONTAINERS", 5));
export const MAX_PROMPT_MESSAGES = 200;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const TRIGGER_PATTERN = new RegExp(`^@${escapeRegex(ASSISTANT_NAME)}\\b`, "i");

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

const rawDbBackend = process.env.DB_BACKEND || envConfig.DB_BACKEND || "sqlite";
if (rawDbBackend !== "sqlite" && rawDbBackend !== "postgres") {
  throw new Error(`Invalid DB_BACKEND="${rawDbBackend}" — must be "sqlite" or "postgres"`);
}
export const DB_BACKEND: "sqlite" | "postgres" = rawDbBackend;

const rawDatabaseUrl = process.env.DATABASE_URL || envConfig.DATABASE_URL || "";
export const DATABASE_URL =
  rawDatabaseUrl || (DB_BACKEND === "sqlite" ? path.join(STORE_DIR, "messages.db") : "");

export const TANREN_API_URL = process.env.TANREN_API_URL || "";
