/**
 * Config-driven remote MCP server registration.
 *
 * Loads MCP server definitions from mcp-servers.json (global and per-group),
 * resolves ${ENV_VAR} references from the host environment, and filters by
 * onlyMain. The resolved configs are passed to containers via ContainerInput
 * so agent-runner can register them with the Claude Agent SDK.
 */
import fs from "fs";
import path from "path";
import { z } from "zod";

import { GROUPS_DIR } from "./config.js";
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
 * Replace ${VAR_NAME} patterns with values from process.env.
 * Returns the interpolated string and any unresolved variable names.
 */
export function interpolateEnvVars(value: string): { result: string; missing: string[] } {
  const missing: string[] = [];
  const result = value.replace(ENV_VAR_PATTERN, (_match: string, varName: string) => {
    const envValue = process.env[varName];
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
function resolveServerEnvVars(name: string, entry: McpServerEntry): ResolvedMcpServer | null {
  const allMissing: string[] = [];

  const { result: url, missing: urlMissing } = interpolateEnvVars(entry.url);
  allMissing.push(...urlMissing);

  let headers: Record<string, string> | undefined;
  if (entry.headers) {
    headers = {};
    for (const [key, value] of Object.entries(entry.headers)) {
      const { result, missing } = interpolateEnvVars(value);
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

/**
 * Load and validate a single mcp-servers.json file.
 * Returns null if the file does not exist.
 * Throws on malformed JSON or schema validation failure (intentional crash).
 */
function loadConfigFile(filePath: string): Record<string, McpServerEntry> | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return McpServersFileSchema.parse(raw);
}

/**
 * Load global + per-group MCP server configs, resolve env vars, filter by onlyMain.
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
  const global = loadConfigFile(configPath) ?? {};

  const groupConfigPath = path.join(GROUPS_DIR, groupFolder, "mcp-servers.json");
  const group = loadConfigFile(groupConfigPath) ?? {};

  // Merge: group entries override same-named global entries
  const merged = { ...global, ...group };

  if (Object.keys(merged).length === 0) return undefined;

  const resolved: Record<string, ResolvedMcpServer> = {};
  for (const [name, entry] of Object.entries(merged)) {
    if (entry.onlyMain && !isMain) continue;

    const server = resolveServerEnvVars(name, entry);
    if (server) {
      resolved[name] = server;
    }
  }

  if (Object.keys(resolved).length === 0) return undefined;

  logger.info({ servers: Object.keys(resolved), groupFolder }, "Loaded MCP server configs");

  return resolved;
}
