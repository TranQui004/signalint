import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isRecord } from "./util/index.js";
import { type MonorepoMode, isMonorepoMode } from "./workspace/types.js";

export const ENGINE_NAMES = ["oxlint", "tsc", "biome", "eslint"] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

export type BiomeEngineConfig = boolean | { includeFormatter: boolean };

export const MCP_PAYLOAD_MODES = ["text", "structured", "both"] as const;

export type McpPayloadMode = (typeof MCP_PAYLOAD_MODES)[number];

export const FLAT_ESLINT_CONFIG_FILES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
] as const;

/** Checks whether a project contains an ESLint flat configuration file. */
export function hasFlatEslintConfig(cwd: string = process.cwd()): boolean {
  return FLAT_ESLINT_CONFIG_FILES.some((name) => existsSync(resolve(cwd, name)));
}

export interface EngineSelection {
  oxlint: boolean;
  tsc: boolean;
  biome: BiomeEngineConfig;
  eslint: boolean;
}

/** Returns whether an engine selection is enabled. */
export function isEngineEnabled(selection: boolean | { includeFormatter: boolean }): boolean {
  return typeof selection === "boolean" ? selection : true;
}

/** Returns whether Biome formatter diagnostics should be retained. */
export function shouldIncludeBiomeFormatter(selection: BiomeEngineConfig): boolean {
  return typeof selection === "object" && selection !== null && Boolean(selection.includeFormatter);
}

export interface EngineTimeouts {
  oxlint: number;
  tsc: number;
  biome: number;
  eslint: number;
}

export interface SignalintConfig {
  engines: EngineSelection;
  ignore: string[];
  timeoutsMs: EngineTimeouts;
  mcpPayload: McpPayloadMode;
  monorepoMode?: MonorepoMode | undefined;
}

export const DEFAULT_CONFIG: Readonly<SignalintConfig> = {
  engines: {
    oxlint: true,
    tsc: true,
    biome: false,
    eslint: false,
  },
  ignore: ["node_modules/**", "dist/**", ".signalint/**"],
  timeoutsMs: {
    oxlint: 30_000,
    tsc: 60_000,
    biome: 30_000,
    eslint: 30_000,
  },
  mcpPayload: "both",
};

/** Resolves the active MCP payload mode considering env var, config setting, and default. */
export function resolveMcpPayloadMode(
  configPayload?: McpPayloadMode,
  envValue: string | undefined = process.env.SIGNALINT_MCP_PAYLOAD,
): McpPayloadMode {
  if (envValue !== undefined && envValue.trim() !== "") {
    const trimmed = envValue.trim();
    if (trimmed === "text" || trimmed === "structured" || trimmed === "both") {
      return trimmed;
    }
    throw new Error(`Invalid SIGNALINT_MCP_PAYLOAD "${envValue}": expected "text", "structured", or "both".`);
  }
  if (configPayload !== undefined) {
    return configPayload;
  }
  return DEFAULT_CONFIG.mcpPayload;
}

/** Resolves the active monorepo mode considering env var, config setting, and default. */
export function resolveMonorepoMode(
  configMode?: MonorepoMode,
  envValue: string | undefined = process.env.SIGNALINT_MONOREPO_MODE,
): MonorepoMode {
  if (envValue !== undefined && envValue.trim() !== "") {
    const trimmed = envValue.trim();
    if (isMonorepoMode(trimmed)) {
      return trimmed;
    }
    throw new Error(`Invalid SIGNALINT_MONOREPO_MODE "${envValue}": expected "off", "auto", or "strict".`);
  }
  if (configMode !== undefined) {
    return configMode;
  }
  return "off";
}

/** Loads signalint.config.json from a project root and fills omitted settings with defaults. */
export async function loadSignalintConfig(cwd: string = process.cwd()): Promise<SignalintConfig> {
  const configPath = resolve(cwd, "signalint.config.json");
  let serialized: string;
  try {
    serialized = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      const def = cloneDefaultConfig(cwd);
      const monorepo = resolveMonorepoMode(def.monorepoMode);
      return {
        ...def,
        mcpPayload: resolveMcpPayloadMode(def.mcpPayload),
        ...(monorepo !== "off" ? { monorepoMode: monorepo } : {}),
      };
    }
    throw error;
  }

  const parsed = parseSignalintConfig(serialized, cwd);
  const monorepo = resolveMonorepoMode(parsed.monorepoMode);
  return {
    ...parsed,
    mcpPayload: resolveMcpPayloadMode(parsed.mcpPayload),
    ...(monorepo !== "off" ? { monorepoMode: monorepo } : {}),
  };
}

/** Synchronously loads signalint.config.json from a project root and fills omitted settings with defaults. */
export function loadSignalintConfigSync(cwd: string = process.cwd()): SignalintConfig {
  const configPath = resolve(cwd, "signalint.config.json");
  let serialized: string;
  try {
    serialized = readFileSync(configPath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      const def = cloneDefaultConfig(cwd);
      const monorepo = resolveMonorepoMode(def.monorepoMode);
      return {
        ...def,
        mcpPayload: resolveMcpPayloadMode(def.mcpPayload),
        ...(monorepo !== "off" ? { monorepoMode: monorepo } : {}),
      };
    }
    throw error;
  }

  const parsed = parseSignalintConfig(serialized, cwd);
  const monorepo = resolveMonorepoMode(parsed.monorepoMode);
  return {
    ...parsed,
    mcpPayload: resolveMcpPayloadMode(parsed.mcpPayload),
    ...(monorepo !== "off" ? { monorepoMode: monorepo } : {}),
  };
}

/** Parses a Signalint config document and rejects unknown or incorrectly typed settings. */
export function parseSignalintConfig(serialized: string, cwd?: string): SignalintConfig {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) {
    throw new Error("signalint.config.json must contain a JSON object.");
  }
  assertKnownKeys(
    parsed,
    new Set(["engines", "ignore", "timeoutsMs", "mcpPayload", "monorepoMode"]),
    "configuration",
  );

  const monorepoMode = parseMonorepoMode(parsed["monorepoMode"]);

  return {
    engines: parseEngineSelection(parsed.engines, cwd),
    ignore: parseIgnoreGlobs(parsed.ignore),
    timeoutsMs: parseEngineTimeouts(parsed.timeoutsMs),
    mcpPayload: parseMcpPayload(parsed.mcpPayload),
    ...(monorepoMode !== undefined ? { monorepoMode } : {}),
  };
}

function parseMonorepoMode(value: unknown): MonorepoMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isMonorepoMode(value)) {
    return value;
  }
  throw new Error('signalint.config.json field "monorepoMode" must be "off", "auto", or "strict".');
}

/** Returns true when a normalized project-relative path matches one configured ignore glob. */
export function isIgnoredPath(path: string, ignoreGlobs: readonly string[]): boolean {
  const normalizedPath = normalizePath(path);
  return ignoreGlobs.some((glob) => globToRegExp(glob).test(normalizedPath));
}

/** Removes ignored paths while preserving the caller's original path strings and order. */
export function filterIgnoredPaths(
  paths: readonly string[],
  ignoreGlobs: readonly string[],
): string[] {
  return paths.filter((path) => !isIgnoredPath(path, ignoreGlobs));
}

function parseEngineSelection(value: unknown, cwd?: string): EngineSelection {
  const defaultEslint = cwd !== undefined ? hasFlatEslintConfig(cwd) : false;
  if (value === undefined) {
    return { ...DEFAULT_CONFIG.engines, eslint: defaultEslint };
  }
  if (!isRecord(value)) {
    throw new Error('signalint.config.json field "engines" must be an object.');
  }
  assertKnownKeys(value, new Set(ENGINE_NAMES), '"engines"');

  return {
    oxlint: readOptionalBoolean(value, "oxlint", DEFAULT_CONFIG.engines.oxlint),
    tsc: readOptionalBoolean(value, "tsc", DEFAULT_CONFIG.engines.tsc),
    biome: parseBiomeOption(value.biome),
    eslint: readOptionalBoolean(value, "eslint", defaultEslint),
  };
}

function parseBiomeOption(value: unknown): BiomeEngineConfig {
  if (value === undefined) {
    return DEFAULT_CONFIG.engines.biome;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (isRecord(value)) {
    assertKnownKeys(value, new Set(["includeFormatter"]), '"engines.biome"');
    if (typeof value.includeFormatter !== "boolean") {
      throw new Error('signalint.config.json engine "biome.includeFormatter" must be a boolean.');
    }
    return { includeFormatter: value.includeFormatter };
  }
  throw new Error('signalint.config.json engine "biome" must be a boolean or an object with "includeFormatter".');
}

function parseIgnoreGlobs(value: unknown): string[] {
  if (value === undefined) {
    return [...DEFAULT_CONFIG.ignore];
  }
  if (!Array.isArray(value) || !value.every((glob) => typeof glob === "string" && glob !== "")) {
    throw new Error('signalint.config.json field "ignore" must be an array of non-empty strings.');
  }
  return [...value];
}

function parseEngineTimeouts(value: unknown): EngineTimeouts {
  if (value === undefined) {
    return { ...DEFAULT_CONFIG.timeoutsMs };
  }
  if (!isRecord(value)) {
    throw new Error('signalint.config.json field "timeoutsMs" must be an object.');
  }
  assertKnownKeys(value, new Set(ENGINE_NAMES), '"timeoutsMs"');
  return {
    oxlint: readOptionalTimeout(value, "oxlint", DEFAULT_CONFIG.timeoutsMs.oxlint),
    tsc: readOptionalTimeout(value, "tsc", DEFAULT_CONFIG.timeoutsMs.tsc),
    biome: readOptionalTimeout(value, "biome", DEFAULT_CONFIG.timeoutsMs.biome),
    eslint: readOptionalTimeout(value, "eslint", DEFAULT_CONFIG.timeoutsMs.eslint),
  };
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: EngineName,
  defaultValue: boolean,
): boolean {
  const value = record[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new Error(`signalint.config.json engine "${key}" must be a boolean.`);
  }
  return value;
}

function readOptionalTimeout(
  record: Record<string, unknown>,
  key: EngineName,
  defaultValue: number,
): number {
  const value = record[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`signalint.config.json timeout "${key}" must be a positive integer in milliseconds.`);
  }
  return value;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    throw new Error(`Unknown ${label} field "${unknownKey}".`);
  }
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizePath(glob).replace(/^\.\//, "");
  if (normalized.endsWith("/**")) {
    const base = normalized.slice(0, -3);
    return new RegExp(`^${escapePattern(base)}(?:/.*)?$`);
  }
  let expression = "^";

  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    const next = normalized[index + 1];
    if (character === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else if (character !== undefined) {
      expression += escapeRegExp(character);
    }
  }

  return new RegExp(`${expression}$`);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function escapeRegExp(value: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(value) ? `\\${value}` : value;
}

function escapePattern(value: string): string {
  return [...value].map(escapeRegExp).join("");
}

function parseMcpPayload(value: unknown): McpPayloadMode {
  if (value === undefined) {
    return DEFAULT_CONFIG.mcpPayload;
  }
  if (typeof value !== "string" || !MCP_PAYLOAD_MODES.includes(value as McpPayloadMode)) {
    throw new Error('signalint.config.json field "mcpPayload" must be "text", "structured", or "both".');
  }
  return value as McpPayloadMode;
}

function cloneDefaultConfig(cwd?: string): SignalintConfig {
  const defaultEslint = cwd !== undefined ? hasFlatEslintConfig(cwd) : false;
  return {
    engines: { ...DEFAULT_CONFIG.engines, eslint: defaultEslint },
    ignore: [...DEFAULT_CONFIG.ignore],
    timeoutsMs: { ...DEFAULT_CONFIG.timeoutsMs },
    mcpPayload: DEFAULT_CONFIG.mcpPayload,
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
