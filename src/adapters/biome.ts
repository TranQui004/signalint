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

export interface BiomeRunOptions {
  cwd?: string | undefined;
  includeFormatter?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** Parses pinned Biome JSON reporter output into exact Normalized Issue objects. */
export function parseBiomeOutput(
  output: string,
  cwd: string = process.cwd(),
  includeFormatter: boolean = false,
): NormalizedIssue[] {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.diagnostics)) {
    throw new Error("Biome output did not contain a diagnostics array.");
  }
  const filtered = parsed.diagnostics.filter((diagnostic) => {
    if (!isRecord(diagnostic)) {
      return false;
    }
    if (!includeFormatter && diagnostic.category === "format") {
      return false;
    }
    return true;
  });
  return filtered.map((diagnostic) => normalizeBiomeDiagnostic(diagnostic, cwd));
}

/** Runs the pinned Biome check command for supplied paths and returns normalized diagnostics. */
export async function runBiome(
  paths: readonly string[],
  options: BiomeRunOptions = {},
): Promise<NormalizedIssue[]> {
  try {
    const cwd = options.cwd ?? process.cwd();
    const result = await runBiomeProcess(paths, cwd, options);
    const issues = result.stdout.trim() === ""
      ? []
      : parseBiomeOutput(result.stdout, cwd, options.includeFormatter ?? false);
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
  if (!isRecord(diagnostic)) {
    throw new Error("Biome returned a diagnostic that was not an object.");
  }
  const location = isRecord(diagnostic.location) ? diagnostic.location : {};
  const start = isRecord(location.start) ? location.start : {};
  const file = typeof location.path === "string" ? normalizeFile(location.path, cwd) : "";
  const line = typeof start.line === "number" && Number.isInteger(start.line) ? start.line : 1;
  const col = typeof start.column === "number" && Number.isInteger(start.column) ? start.column : 1;
  const rule = typeof diagnostic.category === "string" ? diagnostic.category : "unknown";
  const rawMessage = typeof diagnostic.message === "string" ? diagnostic.message : "";
  const { severity, message } = readSeverityAndMessage(diagnostic.severity, rawMessage);
  const fixable = isBiomeDiagnosticFixable(diagnostic);

  return {
    issueId: createIssueId(file, rule, line, message),
    file,
    line,
    col,
    engine: "biome",
    rule,
    severity,
    message,
    fixable,
  };
}

function readSeverityAndMessage(
  value: unknown,
  rawMessage: string,
): { severity: IssueSeverity; message: string } {
  if (value === "error") {
    return { severity: "error", message: normalizeIssueMessage(rawMessage) };
  }
  if (value === "warning" || value === "info") {
    return { severity: "warning", message: normalizeIssueMessage(rawMessage) };
  }
  if (value === "fatal") {
    return { severity: "error", message: normalizeIssueMessage(rawMessage) };
  }
  const prefix = `[${String(value)}] `;
  return {
    severity: "error",
    message: normalizeIssueMessage(`${prefix}${rawMessage}`),
  };
}

function isBiomeDiagnosticFixable(diagnostic: Record<string, unknown>): boolean {
  const advicesValue = diagnostic.advices;
  const list: unknown[] = Array.isArray(advicesValue)
    ? advicesValue
    : isRecord(advicesValue) && Array.isArray(advicesValue.advices)
      ? advicesValue.advices
      : [];

  return list.some((advice) => {
    if (!isRecord(advice)) {
      return false;
    }
    if (typeof advice.text === "string" && /safe fix/i.test(advice.text)) {
      return true;
    }
    if (typeof advice.message === "string" && /safe fix/i.test(advice.message)) {
      return true;
    }
    return false;
  });
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
  return runEngineCommand(
    process.execPath,
    createBiomeCliArgs(cliPath, paths, options.includeFormatter ?? false),
    {
      cwd,
      engine: "biome",
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_CONFIG.timeoutsMs.biome,
    },
  );
}

/** Builds Biome argv with optional formatter suppression flags and an end-of-options separator. */
export function createBiomeCliArgs(
  cliPath: string,
  paths: readonly string[],
  includeFormatter: boolean = false,
): string[] {
  const args = [cliPath, "check", "--reporter=json"];
  if (!includeFormatter) {
    args.push(
      "--javascript-formatter-enabled=false",
      "--json-formatter-enabled=false",
      "--css-formatter-enabled=false",
      "--graphql-formatter-enabled=false",
    );
  }
  args.push("--", ...paths);
  return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
