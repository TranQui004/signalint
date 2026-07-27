import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const ENGINE_NAMES = ["oxlint", "tsc", "biome"] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

export interface EngineSelection {
  oxlint: boolean;
  tsc: boolean;
  biome: boolean;
}

export interface EngineTimeouts {
  oxlint: number;
  tsc: number;
  biome: number;
}

export interface SignalintConfig {
  engines: EngineSelection;
  ignore: string[];
  timeoutsMs: EngineTimeouts;
}

export const DEFAULT_CONFIG: Readonly<SignalintConfig> = {
  engines: {
    oxlint: true,
    tsc: true,
    biome: false,
  },
  ignore: ["node_modules/**", "dist/**", ".signalint/**"],
  timeoutsMs: {
    oxlint: 30_000,
    tsc: 120_000,
    biome: 30_000,
  },
};

/** Loads signalint.config.json from a project root and fills omitted settings with defaults. */
export async function loadSignalintConfig(cwd: string = process.cwd()): Promise<SignalintConfig> {
  const configPath = resolve(cwd, "signalint.config.json");
  let serialized: string;
  try {
    serialized = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return cloneDefaultConfig();
    }
    throw error;
  }

  return parseSignalintConfig(serialized);
}

/** Parses a Signalint config document and rejects unknown or incorrectly typed settings. */
export function parseSignalintConfig(serialized: string): SignalintConfig {
  const parsed: unknown = JSON.parse(serialized);
  if (!isRecord(parsed)) {
    throw new Error("signalint.config.json must contain a JSON object.");
  }
  assertKnownKeys(parsed, new Set(["engines", "ignore", "timeoutsMs"]), "configuration");

  return {
    engines: parseEngineSelection(parsed.engines),
    ignore: parseIgnoreGlobs(parsed.ignore),
    timeoutsMs: parseEngineTimeouts(parsed.timeoutsMs),
  };
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

function parseEngineSelection(value: unknown): EngineSelection {
  if (value === undefined) {
    return { ...DEFAULT_CONFIG.engines };
  }
  if (!isRecord(value)) {
    throw new Error('signalint.config.json field "engines" must be an object.');
  }
  assertKnownKeys(value, new Set(ENGINE_NAMES), '"engines"');

  return {
    oxlint: readOptionalBoolean(value, "oxlint", DEFAULT_CONFIG.engines.oxlint),
    tsc: readOptionalBoolean(value, "tsc", DEFAULT_CONFIG.engines.tsc),
    biome: readOptionalBoolean(value, "biome", DEFAULT_CONFIG.engines.biome),
  };
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

function cloneDefaultConfig(): SignalintConfig {
  return {
    engines: { ...DEFAULT_CONFIG.engines },
    ignore: [...DEFAULT_CONFIG.ignore],
    timeoutsMs: { ...DEFAULT_CONFIG.timeoutsMs },
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
