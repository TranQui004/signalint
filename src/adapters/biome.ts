import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_CONFIG } from "../config.js";
import {
  createIssueId,
  normalizeIssueMessage,
  type IssueSeverity,
  type NormalizedIssue,
} from "../schema.js";
import {
  attributeEngineError,
  runEngineCommand,
  type CommandResult,
} from "../subprocess.js";

interface BiomeRunOptions {
  cwd?: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

/** Parses pinned Biome JSON reporter output into exact Normalized Issue objects. */
export function parseBiomeOutput(
  output: string,
  cwd: string = process.cwd(),
): NormalizedIssue[] {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.diagnostics)) {
    throw new Error("Biome output did not contain a diagnostics array.");
  }
  return parsed.diagnostics.map((diagnostic) => normalizeBiomeDiagnostic(diagnostic, cwd));
}

/** Runs the pinned Biome check command for supplied paths and returns normalized diagnostics. */
export async function runBiome(
  paths: readonly string[],
  options: BiomeRunOptions = {},
): Promise<NormalizedIssue[]> {
  try {
    const cwd = options.cwd ?? process.cwd();
    const result = await runBiomeProcess(paths, cwd, options);
    const issues = result.stdout.trim() === "" ? [] : parseBiomeOutput(result.stdout, cwd);
    if (result.exitCode !== 0 && issues.length === 0) {
      throw new Error(
        `Biome failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }
    return issues;
  } catch (error: unknown) {
    throw attributeEngineError("biome", error);
  }
}

function normalizeBiomeDiagnostic(diagnostic: unknown, cwd: string): NormalizedIssue {
  if (!isRecord(diagnostic) || !isRecord(diagnostic.location)) {
    throw new Error("Biome returned a diagnostic without a location object.");
  }
  const location = diagnostic.location;
  const start = location.start;
  if (!isRecord(start)) {
    throw new Error("Biome diagnostic location did not contain a start position.");
  }

  const file = normalizeFile(readString(location, "path"), cwd);
  const line = readInteger(start, "line");
  const col = readInteger(start, "column");
  const rule = readString(diagnostic, "category");
  const message = normalizeIssueMessage(readString(diagnostic, "message"));

  return {
    issueId: createIssueId(file, rule, line, message),
    file,
    line,
    col,
    engine: "biome",
    rule,
    severity: readSeverity(diagnostic.severity),
    message,
    fixable: false,
  };
}

function readSeverity(value: unknown): IssueSeverity {
  if (value === "error" || value === "warning") {
    return value;
  }
  throw new Error(`Unsupported Biome severity: ${String(value)}`);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Biome diagnostic field "${key}" was not a string.`);
  }
  return value;
}

function readInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Biome diagnostic field "${key}" was not an integer.`);
  }
  return value;
}

function normalizeFile(file: string, cwd: string): string {
  const absoluteFile = isAbsolute(file) ? file : resolve(cwd, file);
  return relative(cwd, absoluteFile).replaceAll("\\", "/");
}

async function runBiomeProcess(
  paths: readonly string[],
  cwd: string,
  options: BiomeRunOptions,
): Promise<CommandResult> {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@biomejs/biome/package.json");
  const cliPath = resolve(dirname(packagePath), "bin", "biome");
  return runEngineCommand(process.execPath, createBiomeCliArgs(cliPath, paths), {
    cwd,
    engine: "biome",
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_CONFIG.timeoutsMs.biome,
  });
}

/** Builds Biome argv with an end-of-options separator before all file paths. */
export function createBiomeCliArgs(
  cliPath: string,
  paths: readonly string[],
): string[] {
  return [cliPath, "check", "--reporter=json", "--", ...paths];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
