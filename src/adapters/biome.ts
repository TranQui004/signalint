import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  createIssueId,
  normalizeIssueMessage,
  type IssueSeverity,
  type NormalizedIssue,
} from "../schema.js";

interface BiomeRunOptions {
  cwd?: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
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
  const cwd = options.cwd ?? process.cwd();
  const result = await runBiomeProcess(paths, cwd);
  const issues = result.stdout.trim() === "" ? [] : parseBiomeOutput(result.stdout, cwd);
  if (result.exitCode !== 0 && issues.length === 0) {
    throw new Error(`Biome failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
  return issues;
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
): Promise<CommandResult> {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("@biomejs/biome/package.json");
  const cliPath = resolve(dirname(packagePath), "bin", "biome");
  return runCommand(process.execPath, [cliPath, "check", "--reporter=json", ...paths], cwd);
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
