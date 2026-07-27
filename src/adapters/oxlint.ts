import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_CONFIG } from "../config.js";
import {
  createIssueId,
  normalizeIssueMessage,
  type IssueSeverity,
  type NormalizedIssue,
} from "../schema.js";
import { runEngineCommand, type CommandResult } from "../subprocess.js";

interface OxlintRunOptions {
  cwd?: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

/** Parses Oxlint JSON output and assumes filenames are relative to the supplied working directory. */
export function parseOxlintOutput(
  output: string,
  cwd: string = process.cwd(),
): NormalizedIssue[] {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.diagnostics)) {
    throw new Error("Oxlint output did not contain a diagnostics array.");
  }

  return parsed.diagnostics.map((diagnostic) => normalizeOxlintDiagnostic(diagnostic, cwd));
}

/** Runs the pinned Oxlint CLI for the supplied paths and returns normalized diagnostics. */
export async function runOxlint(
  paths: readonly string[],
  options: OxlintRunOptions = {},
): Promise<NormalizedIssue[]> {
  const cwd = options.cwd ?? process.cwd();
  const result = await runOxlintProcess(paths, cwd, options);
  const output = result.stdout.trim() === "" ? result.stderr : result.stdout;
  const issues = output.trim() === "" ? [] : parseOxlintOutput(output, cwd);

  if (result.exitCode !== 0 && issues.length === 0) {
    throw new Error(`Oxlint failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return issues;
}

function normalizeOxlintDiagnostic(diagnostic: unknown, cwd: string): NormalizedIssue {
  if (!isRecord(diagnostic)) {
    throw new Error("Oxlint returned a non-object diagnostic.");
  }

  const location = readLocation(diagnostic.labels);
  const rawMessage = readString(diagnostic, "message");
  const message = normalizeIssueMessage(rawMessage);
  const file = normalizeFile(readString(diagnostic, "filename"), cwd);
  const rule = normalizeRule(readString(diagnostic, "code"));
  const severity = normalizeSeverity(readString(diagnostic, "severity"));

  return {
    issueId: createIssueId(file, rule, location.line, message),
    file,
    line: location.line,
    col: location.col,
    engine: "oxlint",
    rule,
    severity,
    message,
    fixable: hasStructuredFix(diagnostic.fix),
  };
}

function readLocation(labels: unknown): { line: number; col: number } {
  if (!Array.isArray(labels) || labels.length === 0 || !isRecord(labels[0])) {
    throw new Error("Oxlint diagnostic did not contain a source label.");
  }

  const span = labels[0].span;
  if (!isRecord(span) || !isPositiveInteger(span.line) || !isPositiveInteger(span.column)) {
    throw new Error("Oxlint diagnostic label did not contain a valid line and column.");
  }

  return { line: span.line, col: span.column };
}

function hasStructuredFix(fix: unknown): boolean {
  if (!isRecord(fix) || typeof fix.text !== "string") {
    return false;
  }

  const hasRange =
    Array.isArray(fix.range) &&
    fix.range.length === 2 &&
    fix.range.every((value) => typeof value === "number" && Number.isInteger(value));
  const hasSpan =
    isRecord(fix.span) &&
    typeof fix.span.offset === "number" &&
    Number.isInteger(fix.span.offset) &&
    typeof fix.span.length === "number" &&
    Number.isInteger(fix.span.length);

  return hasRange || hasSpan;
}

function normalizeRule(code: string): string {
  const wrappedRule = /^([^(]+)\(([^)]+)\)$/.exec(code);
  const namespace = wrappedRule?.[1];
  const rule = wrappedRule?.[2];
  if (namespace?.toUpperCase() === "TS" && rule !== undefined && /^\d+$/.test(rule)) {
    return `TS${rule}`;
  }
  return rule ?? code;
}

function normalizeSeverity(severity: string): IssueSeverity {
  if (severity === "error" || severity === "warning") {
    return severity;
  }
  throw new Error(`Unsupported Oxlint severity: ${severity}`);
}

function normalizeFile(file: string, cwd: string): string {
  const absoluteFile = isAbsolute(file) ? file : resolve(cwd, file);
  return relative(cwd, absoluteFile).replaceAll("\\", "/");
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Oxlint diagnostic field "${key}" was not a string.`);
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runOxlintProcess(
  paths: readonly string[],
  cwd: string,
  options: OxlintRunOptions,
): Promise<CommandResult> {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("oxlint/package.json");
  const cliPath = resolve(dirname(packagePath), "bin", "oxlint");
  return runEngineCommand(process.execPath, [cliPath, "--format", "json", ...paths], {
    cwd,
    engine: "oxlint",
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_CONFIG.timeoutsMs.oxlint,
  });
}
