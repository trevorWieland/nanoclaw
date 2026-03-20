import fs from "fs";
import path from "path";

import { CONFIG_ROOT } from "./runtime-paths.js";
import { logger } from "./logger.js";

export interface RouteRule {
  eventTypes: string[]; // ["*"] matches all
  jids: string[]; // ["dc:123456"]
}

export interface SourceConfig {
  enabled: boolean;
  routes: RouteRule[];
}

export interface HealthMonitorConfig {
  enabled: boolean;
  pollIntervalMs: number;
  sources: Record<string, SourceConfig>;
  defaultRoutes: RouteRule[];
}

const DEFAULTS: HealthMonitorConfig = {
  enabled: false,
  pollIntervalMs: 300000,
  sources: {},
  defaultRoutes: [],
};

export function loadHealthMonitorConfig(configPath?: string): HealthMonitorConfig {
  const filePath = configPath ?? path.join(CONFIG_ROOT, "health-monitor.json");
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      logger.debug("Health monitor config not found, using defaults");
      return { ...DEFAULTS };
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  return validateConfig(parsed);
}

export function validateConfig(input: unknown): HealthMonitorConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Health monitor config must be a JSON object");
  }

  const obj = input as Record<string, unknown>;

  const enabled = obj.enabled !== undefined ? Boolean(obj.enabled) : DEFAULTS.enabled;
  const pollIntervalMs =
    obj.pollIntervalMs !== undefined ? Number(obj.pollIntervalMs) : DEFAULTS.pollIntervalMs;

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error("pollIntervalMs must be a positive number");
  }

  const sources: Record<string, SourceConfig> = {};
  if (obj.sources !== undefined) {
    if (typeof obj.sources !== "object" || obj.sources === null || Array.isArray(obj.sources)) {
      throw new Error("sources must be an object");
    }
    for (const [name, srcRaw] of Object.entries(obj.sources as Record<string, unknown>)) {
      sources[name] = validateSourceConfig(srcRaw, `sources.${name}`);
    }
  }

  const defaultRoutes =
    obj.defaultRoutes !== undefined
      ? validateRoutes(obj.defaultRoutes, "defaultRoutes")
      : DEFAULTS.defaultRoutes;

  return { enabled, pollIntervalMs, sources, defaultRoutes };
}

function validateSourceConfig(input: unknown, configPath: string): SourceConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${configPath} must be an object`);
  }
  const obj = input as Record<string, unknown>;
  const enabled = obj.enabled !== undefined ? Boolean(obj.enabled) : false;
  const routes = obj.routes !== undefined ? validateRoutes(obj.routes, `${configPath}.routes`) : [];
  return { enabled, routes };
}

function validateRoutes(input: unknown, configPath: string): RouteRule[] {
  if (!Array.isArray(input)) {
    throw new Error(`${configPath} must be an array`);
  }
  return input.map((rule, i) => validateRouteRule(rule, `${configPath}[${i}]`));
}

function validateRouteRule(input: unknown, configPath: string): RouteRule {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${configPath} must be an object`);
  }
  const obj = input as Record<string, unknown>;

  if (!Array.isArray(obj.eventTypes)) {
    throw new Error(`${configPath}.eventTypes must be a string array`);
  }
  for (const et of obj.eventTypes) {
    if (typeof et !== "string") {
      throw new Error(`${configPath}.eventTypes must be a string array`);
    }
  }

  if (!Array.isArray(obj.jids)) {
    throw new Error(`${configPath}.jids must be a string array`);
  }
  if (obj.jids.length === 0) {
    throw new Error(`${configPath}.jids must not be empty`);
  }
  for (const jid of obj.jids) {
    if (typeof jid !== "string" || jid === "") {
      throw new Error(`${configPath}.jids must contain non-empty strings`);
    }
  }

  return {
    eventTypes: obj.eventTypes as string[],
    jids: obj.jids as string[],
  };
}

export function resolveJids(
  config: HealthMonitorConfig,
  eventType: string,
  sourceName: string,
): string[] {
  const sourceConfig = config.sources[sourceName];

  // Check source-specific routes first
  if (sourceConfig?.enabled) {
    for (const rule of sourceConfig.routes) {
      if (rule.eventTypes.includes("*") || rule.eventTypes.includes(eventType)) {
        return rule.jids;
      }
    }
  }

  // Fall back to defaultRoutes
  for (const rule of config.defaultRoutes) {
    if (rule.eventTypes.includes("*") || rule.eventTypes.includes(eventType)) {
      return rule.jids;
    }
  }

  return [];
}
