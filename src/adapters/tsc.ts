import { mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

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
import { containProjectPath, resolveProjectPath } from "../projectPaths.js";

interface TscRunOptions {
  cwd?: string;
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

interface PendingDiagnostic {
  file: string;
  line: number;
  col: number;
  severity: IssueSeverity;
  rule: string;
  messageParts: string[];
}

interface EffectiveProjectConfig {
  hasReferences: boolean;
  skipLibCheck: boolean | undefined;
}

const DIAGNOSTIC_START =
  /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+((?:TS)?\d+):\s*(.*)$/;

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

/** Runs the pinned TypeScript CLI as a whole-project incremental check resolved from supplied paths. */
export async function runTsc(
  paths: readonly string[],
  options: TscRunOptions = {},
): Promise<NormalizedIssue[]> {
  try {
    const cwd = options.cwd ?? process.cwd();
    const args = await createTscArgs(paths, cwd, options);
    const result = await runTscProcess(args, cwd, options);
    const output = [result.stdout, result.stderr]
      .filter((part) => part.trim() !== "")
      .join("\n");
    const issues = parseTscOutput(output, cwd);

    if (result.exitCode !== 0 && issues.length === 0) {
      throw new Error(`tsc failed with exit code ${String(result.exitCode)}: ${output.trim()}`);
    }

    return issues;
  } catch (error: unknown) {
    throw attributeEngineError("tsc", error);
  }
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
    rule: normalizeTscRule(rule),
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

/** Builds whole-project tsc arguments, using build mode only for project-reference roots. */
export async function createTscArgs(
  paths: readonly string[],
  cwd: string,
  options: Omit<TscRunOptions, "cwd"> = {},
): Promise<string[]> {
  const projectFile = await resolveProjectFile(paths[0] ?? ".", cwd);
  const config = await readEffectiveProjectConfig(projectFile, cwd, options);
  if (config.hasReferences) {
    return createBuildModeArgs(projectFile);
  }
  return await createProjectModeArgs(projectFile, cwd, config.skipLibCheck);
}

function createBuildModeArgs(projectFile: string): string[] {
  return ["--build", projectFile, "--pretty", "false", "--noEmit", "--incremental"];
}

async function createProjectModeArgs(
  projectFile: string,
  cwd: string,
  skipLibCheck: boolean | undefined,
): Promise<string[]> {
  const buildInfoFile = resolve(cwd, ".signalint", "cache", "tsc.tsbuildinfo");
  await mkdir(dirname(buildInfoFile), { recursive: true });
  const args = [
    "--pretty",
    "false",
    "--noEmit",
    "--project",
    projectFile,
    "--incremental",
    "--tsBuildInfoFile",
    buildInfoFile,
  ];
  if (skipLibCheck === undefined) {
    args.push("--skipLibCheck");
  }
  return args;
}

function normalizeTscRule(rule: string): string {
  return rule.startsWith("TS") ? rule : `TS${rule}`;
}

async function readEffectiveProjectConfig(
  projectFile: string,
  cwd: string,
  options: Omit<TscRunOptions, "cwd">,
): Promise<EffectiveProjectConfig> {
  const result = await runTscProcess(["--showConfig", "--project", projectFile], cwd, options);
  if (result.exitCode !== 0) {
    throw new Error(`tsc --showConfig failed: ${[result.stdout, result.stderr].join("\n").trim()}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed) || !isRecord(parsed.compilerOptions)) {
    throw new Error("tsc --showConfig did not return compilerOptions.");
  }
  const skipLibCheck = parsed.compilerOptions.skipLibCheck;
  if (skipLibCheck !== undefined && typeof skipLibCheck !== "boolean") {
    throw new Error("tsc --showConfig returned a non-boolean skipLibCheck value.");
  }
  if (parsed.references !== undefined && !Array.isArray(parsed.references)) {
    throw new Error("tsc --showConfig returned a non-array references value.");
  }
  return {
    hasReferences: Object.hasOwn(parsed, "references"),
    skipLibCheck,
  };
}

async function resolveProjectFile(path: string, cwd: string): Promise<string> {
  const projectRoot = (await resolveProjectPath(".", cwd)).absolutePath;
  const target = (await resolveProjectPath(path, cwd)).absolutePath;
  const targetStat = await stat(target);
  if (targetStat.isDirectory()) {
    return (await containProjectPath(resolve(target, "tsconfig.json"), projectRoot)).absolutePath;
  }
  if (/^tsconfig(?:\.[^/\\]+)?\.json$/.test(basename(target))) {
    return target;
  }
  return findClosestProjectFile(dirname(target), projectRoot);
}

async function findClosestProjectFile(directory: string, boundary: string): Promise<string> {
  let current = directory;
  const resolvedBoundary = resolve(boundary);
  while (true) {
    const candidate = resolve(current, "tsconfig.json");
    try {
      if ((await stat(candidate)).isFile()) {
        return (await containProjectPath(candidate, boundary)).absolutePath;
      }
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    const parent = dirname(current);
    if (current === parent || current === resolvedBoundary) {
      return (
        await containProjectPath(resolve(resolvedBoundary, "tsconfig.json"), resolvedBoundary)
      ).absolutePath;
    }
    current = parent;
  }
}

function normalizeFile(file: string, cwd: string): string {
  const absoluteFile = isAbsolute(file) ? file : resolve(cwd, file);
  return relative(cwd, absoluteFile).replaceAll("\\", "/");
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runTscProcess(
  args: readonly string[],
  cwd: string,
  options: Omit<TscRunOptions, "cwd">,
): Promise<CommandResult> {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("typescript/package.json");
  const cliPath = resolve(dirname(packagePath), "bin", "tsc");
  return runEngineCommand(process.execPath, [cliPath, ...args], {
    cwd,
    engine: "tsc",
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_CONFIG.timeoutsMs.tsc,
  });
}
