import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { runTsc } from "../engines/tsc.js";
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
} from "../config.js";
import { filterDefaultExcludedIssues } from "./exclusions.js";
import { createIdleEngineStatuses } from "../engineFanout.js";
import {
  readCanonicalProjectRoot,
  resolveProjectPaths,
} from "../projectPaths.js";
import type {
  CheckResponse,
  EngineStatuses,
  NormalizedIssue,
} from "../schema.js";
import { compareIssues, isPathMatching } from "../util/index.js";

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
  const result = await checkFilesWithStats(includedFiles, {
    cwd,
    engines: config.engines,
    signal,
    timeoutsMs: config.timeoutsMs,
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
