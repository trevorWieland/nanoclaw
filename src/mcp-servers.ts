/**
 * Config-driven remote MCP server registration.
 *
 * Loads MCP server definitions from mcp-servers.json (global and per-group),
 * resolves ${ENV_VAR} references from the host environment (global config only),
 * and filters by onlyMain. The resolved configs are passed to containers via
 * ContainerInput so agent-runner can register them with the Claude Agent SDK.
 *
 * Security: Per-group config files are container-writable, so ${ENV_VAR}
 * interpolation is NOT applied to per-group entries. Only the global config
 * (host-only, not container-writable) is trusted for env var resolution.
 */
import fs from "fs";
import path from "path";
import { z } from "zod";

import { GROUPS_DIR } from "./config.js";
import { readEnvFile } from "./env.js";
import { logger } from "./logger.js";

// =========================================
// Schema
// =========================================

const McpServerEntrySchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  onlyMain: z.boolean().optional(),
});

const McpServersFileSchema = z.record(z.string(), McpServerEntrySchema);

/** Server names must be lowercase alphanumeric with hyphens/underscores. */
const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Names reserved for built-in MCP servers that must not be overridden. */
const RESERVED_SERVER_NAMES = new Set(["nanoclaw", "tanren"]);

type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

/** Resolved server config (env vars interpolated, onlyMain stripped). */
interface ResolvedMcpServer {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

// =========================================
// Env var interpolation
// =========================================

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Replace ${VAR_NAME} patterns with values from the given env map.
 * Returns the interpolated string and any unresolved variable names.
 */
export function interpolateEnvVars(
  value: string,
  env: Record<string, string | undefined> = process.env,
): { result: string; missing: string[] } {
  const missing: string[] = [];
  const result = value.replace(ENV_VAR_PATTERN, (_match: string, varName: string) => {
    const envValue = env[varName];
    if (envValue === undefined) {
      missing.push(varName);
      return `\${${varName}}`;
    }
    return envValue;
  });
  return { result, missing };
}

/**
 * Resolve all ${VAR} references in a server entry's url and headers.
 * Returns null (with error log) if any variables are unresolved.
 */
function resolveServerEnvVars(
  name: string,
  entry: McpServerEntry,
  env: Record<string, string | undefined>,
): ResolvedMcpServer | null {
  const allMissing: string[] = [];

  const { result: url, missing: urlMissing } = interpolateEnvVars(entry.url, env);
  allMissing.push(...urlMissing);

  let headers: Record<string, string> | undefined;
  if (entry.headers) {
    headers = {};
    for (const [key, value] of Object.entries(entry.headers)) {
      const { result, missing } = interpolateEnvVars(value, env);
      allMissing.push(...missing);
      headers[key] = result;
    }
  }

  if (allMissing.length > 0) {
    logger.error(
      { server: name, missingVars: allMissing },
      `Skipping MCP server "${name}": unresolved environment variables: ${allMissing.join(", ")}`,
    );
    return null;
  }

  return { type: entry.type, url, ...(headers && { headers }) };
}

// =========================================
// Config loading
// =========================================

/** Max config file size (64 KB) — prevents memory exhaustion from untrusted paths. */
const MAX_CONFIG_FILE_SIZE = 65536;

/**
 * Load and validate a single mcp-servers.json file.
 * Returns null if the file does not exist.
 * Throws on malformed JSON or schema validation failure (intentional crash).
 *
 * Security: per-group paths are container-writable, so we reject symlinks
 * and enforce a size limit to prevent host-side resource exhaustion.
 */
function loadConfigFile(filePath: string): Record<string, McpServerEntry> | null {
  // Open once with O_NOFOLLOW so the kernel rejects symlinks atomically.
  // Then fstat + read on the same fd to eliminate the TOCTOU window between
  // validation and read. Per-group folders are container-writable, so these
  // paths are untrusted — a container could race-replace the file between a
  // separate stat and read.
  let fd: number;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") {
      logger.error({ filePath }, "MCP config is a symlink, skipping");
      return null;
    }
    throw err;
  }

  let parsed: Record<string, McpServerEntry>;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      logger.error({ filePath }, "MCP config is not a regular file, skipping");
      return null;
    }
    if (stat.size > MAX_CONFIG_FILE_SIZE) {
      logger.error(
        { filePath, size: stat.size, maxSize: MAX_CONFIG_FILE_SIZE },
        "MCP config file exceeds size limit, skipping",
      );
      return null;
    }

    const raw = JSON.parse(fs.readFileSync(fd, "utf-8"));
    parsed = McpServersFileSchema.parse(raw);
  } finally {
    fs.closeSync(fd);
  }

  // Validate server names: safe characters only, no reserved names
  for (const name of Object.keys(parsed)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid MCP server name "${name}" in ${filePath}: names must match /^[a-z0-9][a-z0-9_-]*$/`,
      );
    }
    if (RESERVED_SERVER_NAMES.has(name)) {
      throw new Error(
        `Reserved MCP server name "${name}" in ${filePath}: "${name}" is a built-in server and cannot be overridden`,
      );
    }
  }

  return parsed;
}

/**
 * Check if a string contains ${VAR} patterns.
 * Uses a fresh regex to avoid global-flag lastIndex statefulness.
 */
function containsEnvVarRefs(value: string): boolean {
  return /\$\{[^}]+\}/.test(value);
}

/**
 * Reject a per-group entry if it contains ${VAR} patterns in url or headers.
 * Per-group folders are container-writable, so interpolation is not trusted.
 * Returns a ResolvedMcpServer with literal values, or null if refs found.
 */
function resolveGroupEntry(name: string, entry: McpServerEntry): ResolvedMcpServer | null {
  const refs: string[] = [];
  if (containsEnvVarRefs(entry.url)) refs.push("url");
  if (entry.headers) {
    for (const [key, value] of Object.entries(entry.headers)) {
      if (containsEnvVarRefs(value)) refs.push(`headers.${key}`);
    }
  }

  if (refs.length > 0) {
    logger.error(
      { server: name, fields: refs },
      `Skipping per-group MCP server "${name}": environment variable references are not allowed in per-group configs (fields: ${refs.join(", ")})`,
    );
    return null;
  }

  return {
    type: entry.type,
    url: entry.url,
    ...(entry.headers && { headers: { ...entry.headers } }),
  };
}

/**
 * Load global + per-group MCP server configs, resolve env vars, filter by onlyMain.
 *
 * Security model:
 * - Global config (CONFIG_ROOT/mcp-servers.json): trusted, ${VAR} interpolated
 * - Per-group config (groups/{name}/mcp-servers.json): untrusted (container-writable),
 *   ${VAR} patterns are rejected to prevent host env secret exfiltration
 *
 * @param configPath  Path to the global mcp-servers.json
 * @param groupFolder Group folder name (for per-group overrides)
 * @param isMain      Whether this is the main group
 * @returns Record of server name → resolved config, or undefined if none
 */
export function loadMcpServers(
  configPath: string,
  groupFolder: string,
  isMain: boolean,
): Record<string, ResolvedMcpServer> | undefined {
  const globalEntries = loadConfigFile(configPath) ?? {};
  const groupEntries = loadConfigFile(path.join(GROUPS_DIR, groupFolder, "mcp-servers.json")) ?? {};

  // Determine which names come from which source after merge.
  // Group entries override same-named global entries.
  const allNames = new Set([...Object.keys(globalEntries), ...Object.keys(groupEntries)]);

  if (allNames.size === 0) return undefined;

  // Collect all ${VAR} names referenced in global entries, then resolve them
  // from both process.env and the .env file. NanoClaw intentionally keeps .env
  // secrets out of process.env (see env.ts), so we must check both sources.
  const referencedVars = new Set<string>();
  for (const entry of Object.values(globalEntries)) {
    for (const m of entry.url.matchAll(ENV_VAR_PATTERN)) referencedVars.add(m[1]);
    if (entry.headers) {
      for (const v of Object.values(entry.headers)) {
        for (const m of v.matchAll(ENV_VAR_PATTERN)) referencedVars.add(m[1]);
      }
    }
  }
  const dotEnvValues = referencedVars.size > 0 ? readEnvFile([...referencedVars]) : {};
  // process.env takes precedence over .env (matches config.ts pattern)
  const mergedEnv: Record<string, string | undefined> = { ...dotEnvValues, ...process.env };

  const resolved: Record<string, ResolvedMcpServer> = {};
  for (const name of allNames) {
    const isFromGroup = Object.hasOwn(groupEntries, name);
    const entry = isFromGroup ? groupEntries[name] : globalEntries[name];

    if (entry.onlyMain && !isMain) continue;

    // Global entries: trusted, interpolate env vars (from process.env + .env)
    // Per-group entries: untrusted, reject env var refs
    const server = isFromGroup
      ? resolveGroupEntry(name, entry)
      : resolveServerEnvVars(name, entry, mergedEnv);

    if (server) {
      resolved[name] = server;
    }
  }

  if (Object.keys(resolved).length === 0) return undefined;

  logger.info({ servers: Object.keys(resolved), groupFolder }, "Loaded MCP server configs");

  return resolved;
}
