import { DEFAULT_CONFIG } from "../config.js";
import { EngineDisabledError } from "../engineFanout.js";
import { resolveEngine } from "../engineResolution.js";
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
import { isRecord, normalizeFile } from "../util/index.js";

export interface EslintRunOptions {
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** Parses ESLint JSON reporter output into exact Normalized Issue objects. */
export function parseEslintOutput(
  output: string,
  cwd: string = process.cwd(),
): NormalizedIssue[] {
  const trimmed = output.trim();
  if (trimmed === "") {
    return [];
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("ESLint output did not contain a results array.");
  }

  const issues: NormalizedIssue[] = [];
  for (const fileResult of parsed) {
    if (!isRecord(fileResult)) {
      continue;
    }
    const rawFilePath = typeof fileResult.filePath === "string" ? fileResult.filePath : "";
    const file = normalizeFile(rawFilePath, cwd);
    const messages = Array.isArray(fileResult.messages) ? fileResult.messages : [];

    for (const msg of messages) {
      if (!isRecord(msg)) {
        continue;
      }
      issues.push(normalizeEslintMessage(msg, file));
    }
  }

  return issues;
}

/** Runs project-local ESLint on supplied paths and returns normalized diagnostics. */
export async function runEslint(
  paths: readonly string[],
  options: EslintRunOptions = {},
): Promise<NormalizedIssue[]> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = resolveEngine("eslint", cwd);
  if (resolved === undefined) {
    throw new EngineDisabledError("eslint", "ESLint is not installed in this project.");
  }

  try {
    const result = await runEslintProcess(resolved.binPath, paths, cwd, options);
    const issues = result.stdout.trim() === ""
      ? []
      : parseEslintOutput(result.stdout, cwd);

    if (result.exitCode !== 0 && issues.length === 0) {
      throw new Error(
        `ESLint failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }
    return issues;
  } catch (error: unknown) {
    if (error instanceof EngineDisabledError) {
      throw error;
    }
    throw attributeEngineError("eslint", error);
  }
}

/** Builds ESLint argv with an end-of-options separator before all file paths. */
export function createEslintCliArgs(
  cliPath: string,
  paths: readonly string[],
): string[] {
  return [cliPath, "-f", "json", "--no-error-on-unmatched-pattern", "--", ...paths];
}

async function runEslintProcess(
  binPath: string,
  paths: readonly string[],
  cwd: string,
  options: EslintRunOptions,
): Promise<CommandResult> {
  const args = createEslintCliArgs(binPath, paths);
  return runEngineCommand(process.execPath, args, {
    cwd,
    engine: "eslint",
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_CONFIG.timeoutsMs.eslint,
  });
}

function normalizeEslintMessage(
  msg: Record<string, unknown>,
  file: string,
): NormalizedIssue {
  const line = typeof msg.line === "number" && Number.isInteger(msg.line) && msg.line >= 1
    ? msg.line
    : 1;
  const col = typeof msg.column === "number" && Number.isInteger(msg.column) && msg.column >= 1
    ? msg.column
    : 1;
  const rule = typeof msg.ruleId === "string" && msg.ruleId !== ""
    ? msg.ruleId
    : "eslint/syntax";
  const severity: IssueSeverity = msg.severity === 2 ? "error" : "warning";
  const rawMessage = typeof msg.message === "string" ? msg.message : "ESLint diagnostic";
  const message = normalizeIssueMessage(rawMessage);
  const fixable = "fix" in msg && msg.fix !== null && msg.fix !== undefined;

  return {
    issueId: createIssueId(file, rule, line, message),
    file,
    line,
    col,
    engine: "eslint",
    rule,
    severity,
    message,
    fixable,
  };
}
