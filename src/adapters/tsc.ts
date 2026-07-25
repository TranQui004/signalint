import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  createIssueId,
  normalizeIssueMessage,
  type IssueSeverity,
  type NormalizedIssue,
} from "../schema.js";

interface TscRunOptions {
  cwd?: string;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface PendingDiagnostic {
  file: string;
  line: number;
  col: number;
  severity: IssueSeverity;
  rule: string;
  messageParts: string[];
}

const DIAGNOSTIC_START =
  /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/;

/** Parses non-pretty tsc output and assumes diagnostic filenames are relative to the working directory. */
export function parseTscOutput(
  output: string,
  cwd: string = process.cwd(),
): NormalizedIssue[] {
  const issues: NormalizedIssue[] = [];
  let pending: PendingDiagnostic | undefined;

  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC_START.exec(line);
    if (match !== null) {
      if (pending !== undefined) {
        issues.push(normalizeTscDiagnostic(pending, cwd));
      }
      pending = createPendingDiagnostic(match);
    } else if (pending !== undefined && line.trim() !== "") {
      pending.messageParts.push(line.trim());
    }
  }

  if (pending !== undefined) {
    issues.push(normalizeTscDiagnostic(pending, cwd));
  }
  return issues;
}

/** Runs the pinned TypeScript CLI for supplied files or a single directory containing tsconfig.json. */
export async function runTsc(
  paths: readonly string[],
  options: TscRunOptions = {},
): Promise<NormalizedIssue[]> {
  const cwd = options.cwd ?? process.cwd();
  const args = await createTscArgs(paths, cwd);
  const result = await runTscProcess(args, cwd);
  const output = [result.stdout, result.stderr].filter((part) => part.trim() !== "").join("\n");
  const issues = parseTscOutput(output, cwd);

  if (result.exitCode !== 0 && issues.length === 0) {
    throw new Error(`tsc failed with exit code ${String(result.exitCode)}: ${output.trim()}`);
  }

  return issues;
}

function createPendingDiagnostic(match: RegExpExecArray): PendingDiagnostic {
  const [, file, line, col, severity, rule, message] = match;
  if (
    file === undefined ||
    line === undefined ||
    col === undefined ||
    severity === undefined ||
    rule === undefined ||
    message === undefined
  ) {
    throw new Error("tsc diagnostic did not match the expected output fields.");
  }

  return {
    file,
    line: Number.parseInt(line, 10),
    col: Number.parseInt(col, 10),
    severity: severity === "warning" ? "warning" : "error",
    rule,
    messageParts: [message],
  };
}

function normalizeTscDiagnostic(
  diagnostic: PendingDiagnostic,
  cwd: string,
): NormalizedIssue {
  const file = normalizeFile(diagnostic.file, cwd);
  const message = normalizeIssueMessage(diagnostic.messageParts.join(" "));

  return {
    issueId: createIssueId(file, diagnostic.rule, diagnostic.line, message),
    file,
    line: diagnostic.line,
    col: diagnostic.col,
    engine: "tsc",
    rule: diagnostic.rule,
    severity: diagnostic.severity,
    message,
    fixable: false,
  };
}

async function createTscArgs(paths: readonly string[], cwd: string): Promise<string[]> {
  if (paths.length === 1) {
    const target = resolve(cwd, paths[0] ?? ".");
    const targetStat = await stat(target);
    if (targetStat.isDirectory()) {
      return ["--pretty", "false", "--noEmit", "--project", resolve(target, "tsconfig.json")];
    }
  }

  return ["--pretty", "false", "--noEmit", "--skipLibCheck", ...paths];
}

function normalizeFile(file: string, cwd: string): string {
  const absoluteFile = isAbsolute(file) ? file : resolve(cwd, file);
  return relative(cwd, absoluteFile).replaceAll("\\", "/");
}

async function runTscProcess(
  args: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("typescript/package.json");
  const cliPath = resolve(dirname(packagePath), "bin", "tsc");
  return runCommand(process.execPath, [cliPath, ...args], cwd);
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
