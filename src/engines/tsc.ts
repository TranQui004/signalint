import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

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
import { containProjectPath, resolveProjectPath } from "../projectPaths.js";
import { isRecord, normalizeFile } from "../util/index.js";

export interface TscRunOptions {
  cwd?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
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

/** Process-lifetime cache of tsc --showConfig results, keyed by SHA-256 of the tsconfig file content. */
const configInspectionCache = new Map<string, EffectiveProjectConfig>();

/** Clears the --showConfig inspection cache; call between tests that write different tsconfig content. */
export function clearConfigInspectionCache(): void {
  configInspectionCache.clear();
}

/** Returns the current number of entries in the --showConfig inspection cache; for test verification only. */
export function configInspectionCacheSize(): number {
  return configInspectionCache.size;
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
    if (error instanceof EngineDisabledError) {
      throw error;
    }
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

/** Computes a deterministic project ID slug for tsbuildinfo storage and cache partitioning. */
export function resolveProjectId(projectFile: string, cwd: string): string {
  let canonicalCwd = cwd;
  let canonicalFile = projectFile;
  try {
    canonicalCwd = realpathSync(cwd);
  } catch {}
  try {
    canonicalFile = realpathSync(projectFile);
  } catch {}

  const rel = relative(canonicalCwd, dirname(canonicalFile)).replace(/\\/g, "/");
  if (rel === "" || rel === ".") {
    return "root";
  }
  const slug = rel.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(rel).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

/** Resolves an isolated .tsbuildinfo file path under .signalint/cache/tsc/<project-id>/tsc.tsbuildinfo. */
export function resolveTsBuildInfoPath(projectFile: string, cwd: string): string {
  const stateDir = process.env.SIGNALINT_STATE_DIR?.trim();
  const cacheBase = stateDir && stateDir !== ""
    ? resolve(stateDir, "cache", "tsc")
    : resolve(cwd, ".signalint", "cache", "tsc");

  const projectId = resolveProjectId(projectFile, cwd);
  return resolve(cacheBase, projectId, "tsc.tsbuildinfo");
}

async function createProjectModeArgs(
  projectFile: string,
  cwd: string,
  skipLibCheck: boolean | undefined,
): Promise<string[]> {
  const buildInfoFile = resolveTsBuildInfoPath(projectFile, cwd);
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

/** Executes tsc sequentially across packages in topological order. */
export async function runPackagesTsc(
  packages: readonly { tsconfigPath?: string; relativePath: string }[],
  options: TscRunOptions = {},
): Promise<NormalizedIssue[]> {
  const allIssues: NormalizedIssue[] = [];
  const seenIds = new Set<string>();

  for (const pkg of packages) {
    if (pkg.tsconfigPath !== undefined) {
      const issues = await runTsc([pkg.tsconfigPath], options);
      for (const issue of issues) {
        if (!seenIds.has(issue.issueId)) {
          seenIds.add(issue.issueId);
          allIssues.push(issue);
        }
      }
    }
  }

  return allIssues;
}

function normalizeTscRule(rule: string): string {
  return rule.startsWith("TS") ? rule : `TS${rule}`;
}

async function readEffectiveProjectConfig(
  projectFile: string,
  cwd: string,
  options: Omit<TscRunOptions, "cwd">,
): Promise<EffectiveProjectConfig> {
  const content = await readFile(projectFile, "utf8").catch(() => "");
  const contentHash = createHash("sha256").update(content).digest("hex");
  const cached = configInspectionCache.get(contentHash);
  if (cached !== undefined) {
    return cached;
  }
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
  const config: EffectiveProjectConfig = {
    hasReferences: Object.hasOwn(parsed, "references"),
    skipLibCheck,
  };
  configInspectionCache.set(contentHash, config);
  return config;
}

/** Resolves the effective tsconfig.json project file for a given target path within boundary. */
export async function resolveProjectFile(path: string, cwd: string): Promise<string> {
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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function runTscProcess(
  args: readonly string[],
  cwd: string,
  options: Omit<TscRunOptions, "cwd">,
): Promise<CommandResult> {
  const resolved = resolveEngine("tsc", cwd);
  if (resolved === undefined) {
    throw new EngineDisabledError(
      "tsc",
      "TypeScript is not installed in this project. Install typescript to enable it.",
    );
  }
  return runEngineCommand(process.execPath, [resolved.binPath, ...args], {
    cwd,
    engine: "tsc",
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_CONFIG.timeoutsMs.tsc,
  });
}
