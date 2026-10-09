import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { runTsc } from "../engines/tsc.js";
import { SqliteCache } from "../cache/sqliteCache.js";
import {
  checkFilesWithStats,
  type CacheStats,
  type CheckFilesResult,
} from "../checkFiles.js";
import { clusterIssues, type ClusterResult } from "../cluster/clusterEngine.js";
import {
  filterIgnoredPaths,
  isIgnoredPath,
  loadSignalintConfig,
  resolveMonorepoMode,
  type SignalintConfig,
} from "../config.js";
import { filterDefaultExcludedIssues } from "./exclusions.js";
import { createIdleEngineStatuses } from "../engineFanout.js";
import {
  readCanonicalProjectRoot,
  resolveProjectPaths,
} from "../projectPaths.js";
import type {
  CheckResponse,
  EngineStatus,
  EngineStatuses,
  IssueEngine,
  NormalizedIssue,
} from "../schema.js";
import { compareIssues, isPathMatching } from "../util/index.js";
import {
  buildWorkspaceGraph,
  discoverWorkspacePackages,
  findPackageForFile,
  getTransitiveDependencies,
  hasSolutionStyleTsconfig,
  planWorkspaceChecks,
  type MonorepoMode,
  type WorkspaceGraph,
  type WorkspacePackage,
} from "../workspace/index.js";

export interface IssueProviderResult {
  issues: NormalizedIssue[];
  cache: CacheStats;
  engines: EngineStatuses;
  filteredOutIssueCount?: number;
}

/** Runs configured adapters and returns the compact clustered project response. */
export async function checkProject(
  paths: readonly string[],
  cwd: string = process.cwd(),
): Promise<CheckResponse> {
  return (await checkProjectWithIssues(paths, cwd)).response;
}

/** Runs configured adapters and returns both the clustered issues and the project response. */
export async function checkProjectWithIssues(
  paths: readonly string[],
  cwd: string = process.cwd(),
  options: { compact?: boolean } = {},
): Promise<ClusterResult> {
  const result = await collectProjectIssueResult(paths, cwd);
  const projectRoot = await readCanonicalProjectRoot(cwd);
  return clusterIssues(result.issues, 10, result.engines, projectRoot, options);
}

/** Runs enabled project adapters and excludes diagnostics matching configured ignore globs. */
export async function collectProjectIssues(
  paths: readonly string[],
  cwd: string = process.cwd(),
  signal?: AbortSignal,
): Promise<NormalizedIssue[]> {
  return (await collectProjectIssueResult(paths, cwd, signal)).issues;
}

/** Collects whole-project diagnostic results with cache stats and idle engine statuses. */
export async function collectProjectIssueResult(
  paths: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<IssueProviderResult> {
  const safePaths = (await resolveProjectPaths(paths, cwd)).map((path) => path.relativePath);
  const config = await loadSignalintConfig(cwd);
  const includedPaths = filterIgnoredPaths(safePaths, config.ignore);
  if (includedPaths.length === 0) {
    return {
      issues: [],
      cache: { hits: 0, misses: 0 },
      engines: createIdleEngineStatuses(config.engines),
    };
  }

  const monorepoMode = resolveMonorepoMode(config.monorepoMode);
  if (monorepoMode !== "off") {
    const workspaceResult = await runWorkspaceProjectChecks(
      includedPaths,
      cwd,
      config,
      monorepoMode,
      signal,
    );
    if (workspaceResult !== undefined) {
      return workspaceResult;
    }
  }

  return await runStandardProjectCheck(includedPaths, cwd, config, signal);
}

async function runStandardProjectCheck(
  includedPaths: readonly string[],
  cwd: string,
  config: SignalintConfig,
  signal?: AbortSignal,
): Promise<IssueProviderResult> {
  const files = await expandPathsToFiles(includedPaths, cwd, config.ignore);
  if (files.length === 0) {
    return {
      issues: [],
      cache: { hits: 0, misses: 0 },
      engines: createIdleEngineStatuses(config.engines),
    };
  }

  const checkResult = await checkFilesWithStats(files, {
    cwd,
    engines: config.engines,
    timeoutsMs: config.timeoutsMs,
    signal,
    targetPath: includedPaths[0],
    runners: {
      tsc: (options) => runTsc(includedPaths, options),
    },
  });

  return {
    issues: filterDefaultExcludedIssues(checkResult.issues)
      .filter((issue) => !isIgnoredPath(issue.file, config.ignore))
      .sort(compareIssues),
    cache: checkResult.cache,
    engines: checkResult.engines,
  };
}

async function runWorkspaceProjectChecks(
  includedPaths: readonly string[],
  cwd: string,
  config: SignalintConfig,
  mode: MonorepoMode,
  signal?: AbortSignal,
): Promise<IssueProviderResult | undefined> {
  let discovery;
  try {
    discovery = await discoverWorkspacePackages(cwd, mode);
  } catch (error: unknown) {
    if (mode === "strict") {
      throw error;
    }
    return undefined;
  }

  if (discovery.packages.length === 0) {
    return undefined;
  }

  const graph = buildWorkspaceGraph(cwd, discovery.packages);
  const plan = planWorkspaceChecks(graph, { mode, targetFiles: includedPaths });
  if (plan.fallbackToRoot || plan.targets.length === 0) {
    return undefined;
  }

  const isSolutionRoot =
    includedPaths.includes(".") &&
    (await hasSolutionStyleTsconfig(cwd, discovery.packages));

  if (isSolutionRoot) {
    return undefined;
  }

  return await executeTopologicalPackageChecks(plan.targets, graph, cwd, config, signal);
}

async function executeTopologicalPackageChecks(
  targets: readonly WorkspacePackage[],
  graph: WorkspaceGraph,
  cwd: string,
  config: SignalintConfig,
  signal?: AbortSignal,
): Promise<IssueProviderResult> {
  const stateDir = process.env.SIGNALINT_STATE_DIR?.trim();
  const cachePath = stateDir && stateDir !== ""
    ? resolve(stateDir, "cache.sqlite")
    : resolve(cwd, ".signalint", "cache.sqlite");
  const cache = new SqliteCache(cachePath);

  const accumulatedIssues: NormalizedIssue[] = [];
  const seenIssueIds = new Set<string>();
  let accumulatedCache: CacheStats = { hits: 0, misses: 0 };
  let accumulatedEngines: EngineStatuses = createIdleEngineStatuses(config.engines);

  try {
    for (const pkg of targets) {
      if (signal?.aborted === true) {
        throw signal.reason ?? new Error("Check cancelled");
      }
      const pkgFiles = await expandPathsToFiles([pkg.relativePath], cwd, config.ignore);
      if (pkgFiles.length === 0) {
        continue;
      }
      const depDirs = getTransitiveDependencies(pkg.name, graph).map((p) => p.absolutePath);
      const targetRel = pkg.relativePath;
      const hasTsconfig = pkg.tsconfigPath !== undefined;

      const checkResult = await checkFilesWithStats(pkgFiles, {
        cwd,
        cache,
        engines: { ...config.engines, tsc: hasTsconfig ? config.engines.tsc : false },
        timeoutsMs: config.timeoutsMs,
        signal,
        targetPath: targetRel,
        dependencyDirs: depDirs,
        ...(hasTsconfig ? { runners: { tsc: (opts) => runTsc([targetRel], opts) } } : {}),
      });

      for (const issue of checkResult.issues) {
        if (!seenIssueIds.has(issue.issueId)) {
          seenIssueIds.add(issue.issueId);
          accumulatedIssues.push(issue);
        }
      }
      accumulatedCache = {
        hits: accumulatedCache.hits + checkResult.cache.hits,
        misses: accumulatedCache.misses + checkResult.cache.misses,
      };
      accumulatedEngines = mergeEngineStatuses(accumulatedEngines, checkResult.engines);
    }
  } finally {
    cache.close();
  }

  return {
    issues: filterDefaultExcludedIssues(accumulatedIssues)
      .filter((issue) => !isIgnoredPath(issue.file, config.ignore))
      .sort(compareIssues),
    cache: accumulatedCache,
    engines: accumulatedEngines,
  };
}

function mergeEngineStatuses(current: EngineStatuses, next: EngineStatuses): EngineStatuses {
  const merged: EngineStatuses = { ...current };
  for (const [engine, status] of Object.entries(next) as [IssueEngine, EngineStatus][]) {
    const existing = merged[engine];
    if (existing === undefined || status.status === "error" || (existing.status === "disabled" && status.status === "ok")) {
      merged[engine] = status;
    }
  }
  return merged;
}

/** Walks target project paths and gathers candidate source files respecting ignore globs. */
export async function expandPathsToFiles(
  paths: readonly string[],
  cwd: string,
  ignoreGlobs: readonly string[],
): Promise<string[]> {
  const fileSet = new Set<string>();
  const visitedDirs = new Set<string>();

  async function walk(relativeTarget: string): Promise<void> {
    const absoluteTarget = resolve(cwd, relativeTarget);
    let targetStat;
    try {
      targetStat = await stat(absoluteTarget);
    } catch {
      return;
    }

    if (targetStat.isFile()) {
      if (!isIgnoredPath(relativeTarget, ignoreGlobs)) {
        fileSet.add(relativeTarget);
      }
      return;
    }

    if (!targetStat.isDirectory()) {
      return;
    }

    if (visitedDirs.has(absoluteTarget) || fileSet.size >= 2000) {
      return;
    }
    visitedDirs.add(absoluteTarget);

    let entries;
    try {
      entries = await readdir(absoluteTarget, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".signalint" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const childRelative = relativeTarget === "."
        ? entry.name
        : `${relativeTarget.replace(/\/$/, "")}/${entry.name}`;
      if (isIgnoredPath(childRelative, ignoreGlobs)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(childRelative);
      } else if (entry.isFile()) {
        fileSet.add(childRelative);
      }
    }
  }

  for (const p of paths) {
    await walk(p);
  }

  return Array.from(fileSet);
}

/** Runs enabled incremental adapters and excludes requested or returned ignored paths. */
export async function checkConfiguredFiles(
  files: readonly string[],
  cwd: string = process.cwd(),
  signal?: AbortSignal,
): Promise<NormalizedIssue[]> {
  return (await checkConfiguredFilesWithStats(files, cwd, signal)).issues;
}

/** Runs enabled incremental adapters and returns issues plus cache metrics for session logging. */
export async function checkConfiguredFilesWithStats(
  files: readonly string[],
  cwd: string = process.cwd(),
  signal?: AbortSignal,
): Promise<CheckFilesResult> {
  const safeFiles = (await resolveProjectPaths(files, cwd)).map((path) => path.relativePath);
  const config = await loadSignalintConfig(cwd);
  const includedFiles = filterIgnoredPaths(safeFiles, config.ignore);
  if (includedFiles.length === 0) {
    return {
      issues: [],
      cache: { hits: 0, misses: 0 },
      engines: createIdleEngineStatuses(config.engines),
    };
  }
  const dependencyDirs = await resolveFilesDependencyDirs(includedFiles, cwd, config);
  const result = await checkFilesWithStats(includedFiles, {
    cwd,
    engines: config.engines,
    signal,
    timeoutsMs: config.timeoutsMs,
    targetPath: includedFiles[0],
    dependencyDirs,
  });
  const allIssues = filterDefaultExcludedIssues(result.issues)
    .filter((issue) => !isIgnoredPath(issue.file, config.ignore));
  const scopedIssues = allIssues.filter((issue) => isPathMatching(issue.file, safeFiles));
  const filteredOutIssueCount = allIssues.length - scopedIssues.length;

  return {
    issues: scopedIssues,
    cache: result.cache,
    engines: result.engines,
    filteredOutIssueCount,
  };
}

async function resolveFilesDependencyDirs(
  includedFiles: readonly string[],
  cwd: string,
  config: SignalintConfig,
): Promise<string[] | undefined> {
  const monorepoMode = resolveMonorepoMode(config.monorepoMode);
  if (monorepoMode === "off" || includedFiles[0] === undefined) {
    return undefined;
  }
  try {
    const discovery = await discoverWorkspacePackages(cwd, monorepoMode);
    if (discovery.packages.length === 0) {
      return undefined;
    }
    const graph = buildWorkspaceGraph(cwd, discovery.packages);
    const matchedPkg = findPackageForFile(includedFiles[0].replace(/\\/g, "/"), graph.packages);
    if (matchedPkg === undefined) {
      return undefined;
    }
    return getTransitiveDependencies(matchedPkg.name, graph).map((p) => p.absolutePath);
  } catch {
    return undefined;
  }
}
