import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ENGINE_REGISTRY, ALL_ENGINES } from "./engines/registry.js";
import { resolveProjectFile } from "./engines/tsc.js";
import { createLinkedAbortController } from "./abort.js";
import { createCacheKey, SqliteCache } from "./cache/sqliteCache.js";
import {
  DEFAULT_CONFIG,
  isEngineEnabled,
  shouldIncludeBiomeFormatter,
  type EngineSelection,
  type EngineTimeouts,
} from "./config.js";
import { settleEngineTasks } from "./engineFanout.js";
import {
  createIssueId,
  type EngineStatuses,
  type IssueEngine,
  type NormalizedIssue,
} from "./schema.js";
import { resolveProjectPaths, type ResolvedProjectPath } from "./projectPaths.js";
import { compareIssues, isRecord } from "./util/index.js";

export type CacheEngine = IssueEngine;

export interface EngineRunOptions {
  cwd?: string | undefined;
  includeFormatter?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export type EngineRunner = (
  files: readonly string[],
  options?: EngineRunOptions,
) => Promise<NormalizedIssue[]>;

export type WholeProgramRunner = (
  options?: EngineRunOptions,
) => Promise<NormalizedIssue[]>;

export interface EngineRunners {
  oxlint: EngineRunner;
  tsc: WholeProgramRunner;
  biome: EngineRunner;
  eslint: EngineRunner;
}

export interface CheckFilesOptions {
  cwd?: string;
  cache?: SqliteCache;
  runners?: Partial<EngineRunners>;
  engines?: EngineSelection;
  signal?: AbortSignal | undefined;
  timeoutsMs?: EngineTimeouts;
  targetPath?: string | undefined;
}

export interface CacheStats {
  hits: number;
  misses: number;
}

export interface CheckFilesResult {
  issues: NormalizedIssue[];
  cache: CacheStats;
  engines: EngineStatuses;
}

interface FileSnapshot {
  content: string;
  file: string;
}

interface MissedFile extends FileSnapshot {
  key: string;
}

interface EngineCheckResult {
  issues: NormalizedIssue[];
  cache: CacheStats;
}

const ENGINE_CONFIG_FILES: Record<CacheEngine, readonly string[]> = Object.fromEntries(
  ALL_ENGINES.map((engine) => [engine, ENGINE_REGISTRY[engine].configFiles]),
) as Record<CacheEngine, readonly string[]>;

const DEFAULT_RUNNERS: EngineRunners = {
  oxlint: (files, opts) => ENGINE_REGISTRY.oxlint.run(files, opts),
  tsc: (opts) => ENGINE_REGISTRY.tsc.run(["."], opts),
  biome: (files, opts) => ENGINE_REGISTRY.biome.run(files, opts),
  eslint: (files, opts) => ENGINE_REGISTRY.eslint.run(files, opts),
};

const DEFAULT_ENGINES: EngineSelection = {
  oxlint: true,
  tsc: true,
  biome: false,
  eslint: false,
};

/** Checks files through enabled engines and returns normalized issues without instrumentation. */
export async function checkFiles(
  files: readonly string[],
  options: CheckFilesOptions = {},
): Promise<NormalizedIssue[]> {
  return (await checkFilesWithStats(files, options)).issues;
}

/** Checks files through enabled engines and reports cache lookups for session metrics. */
export async function checkFilesWithStats(
  files: readonly string[],
  options: CheckFilesOptions = {},
): Promise<CheckFilesResult> {
  const cwd = options.cwd ?? process.cwd();
  const cache = options.cache ?? new SqliteCache(resolve(cwd, ".signalint", "cache.sqlite"));
  const ownsCache = options.cache === undefined;
  const linkedAbort = createLinkedAbortController(options.signal);

  try {
    const resolvedFiles = await resolveProjectPaths(files, cwd);
    const snapshots = await mapConcurrent(resolvedFiles, 32, readSnapshot);
    const runners = { ...DEFAULT_RUNNERS, ...options.runners };
    const engines = options.engines ?? DEFAULT_ENGINES;
    const timeoutsMs = options.timeoutsMs ?? DEFAULT_CONFIG.timeoutsMs;
    const fanout = await settleEngineTasks<EngineCheckResult>([
      {
        engine: "oxlint",
        enabled: engines.oxlint,
        run: () => checkFileLocalEngine(
          "oxlint",
          snapshots.filter((snapshot) => isOxlintRelevant(snapshot.file)),
          cwd,
          cache,
          runners.oxlint,
          timeoutsMs.oxlint,
          linkedAbort.controller.signal,
        ),
      },
      {
        engine: "tsc",
        enabled: engines.tsc,
        run: () => checkWholeProgramTsc(
          snapshots,
          cwd,
          cache,
          runners.tsc,
          timeoutsMs.tsc,
          linkedAbort.controller.signal,
          options.targetPath,
        ),
      },
      {
        engine: "biome",
        enabled: isEngineEnabled(engines.biome),
        run: () => checkFileLocalEngine(
          "biome",
          snapshots.filter((snapshot) => isBiomeRelevant(snapshot.file)),
          cwd,
          cache,
          (paths, opts) => runners.biome(paths, {
            ...opts,
            includeFormatter: shouldIncludeBiomeFormatter(engines.biome),
          }),
          timeoutsMs.biome,
          linkedAbort.controller.signal,
        ),
      },
      {
        engine: "eslint",
        enabled: engines.eslint,
        run: () => checkFileLocalEngine(
          "eslint",
          snapshots.filter((snapshot) => isEslintRelevant(snapshot.file)),
          cwd,
          cache,
          runners.eslint,
          timeoutsMs.eslint,
          linkedAbort.controller.signal,
        ),
      },
    ]);
    return {
      issues: fanout.results.flatMap((result) => result.issues).sort(compareIssues),
      cache: sumCacheStats(fanout.results.map((result) => result.cache)),
      engines: fanout.engines,
    };
  } catch (error: unknown) {
    linkedAbort.controller.abort();
    throw error;
  } finally {
    linkedAbort.dispose();
    if (ownsCache) {
      cache.close();
    }
  }
}

/** Hashes all config files for one engine, following tsc extends/references chains. */
export async function computeEngineConfigHash(
  engine: CacheEngine,
  cwd: string,
  targetTsconfigPath?: string,
): Promise<string> {
  const hash = createHash("sha256");
  if (engine === "tsc") {
    const projectFile = targetTsconfigPath ?? resolve(cwd, "tsconfig.json");
    const configFiles = await collectTscConfigFiles(projectFile, new Set());
    for (const absolutePath of Array.from(configFiles).sort()) {
      hash.update(absolutePath);
      hash.update("\0");
      hash.update(await readConfigAbsolute(absolutePath));
      hash.update("\0");
    }
  } else {
    for (const configFile of ENGINE_CONFIG_FILES[engine]) {
      hash.update(configFile);
      hash.update("\0");
      hash.update(await readConfig(configFile, cwd));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

async function checkFileLocalEngine(
  engine: CacheEngine,
  snapshots: readonly FileSnapshot[],
  cwd: string,
  cache: SqliteCache,
  runner: EngineRunner,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<EngineCheckResult> {
  const configHash = await computeEngineConfigHash(engine, cwd);
  cache.invalidateEngine(engine, configHash);

  const hits: NormalizedIssue[] = [];
  const misses: MissedFile[] = [];
  for (const snapshot of snapshots) {
    const key = createCacheKey(snapshot.content, engine, configHash);
    const cached = cache.get(key);
    if (cached === undefined) {
      misses.push({ ...snapshot, key });
    } else {
      hits.push(...relocateIssues(cached, snapshot.file));
    }
  }

  if (misses.length === 0) {
    return {
      issues: hits,
      cache: { hits: snapshots.length, misses: 0 },
    };
  }

  const freshIssues = await runner(
    misses.map((miss) => miss.file),
    { cwd, signal, timeoutMs },
  );
  for (const miss of misses) {
    const fileIssues = freshIssues.filter((issue) => issue.file === miss.file);
    cache.set(miss.key, fileIssues);
  }
  return {
    issues: [...hits, ...freshIssues],
    cache: { hits: snapshots.length - misses.length, misses: misses.length },
  };
}

async function checkWholeProgramTsc(
  snapshots: readonly FileSnapshot[],
  cwd: string,
  cache: SqliteCache,
  runner: WholeProgramRunner,
  timeoutMs: number,
  signal: AbortSignal,
  targetPath?: string | undefined,
): Promise<EngineCheckResult> {
  let targetTsconfigPath: string | undefined;
  const probePath = targetPath ?? snapshots[0]?.file;
  if (probePath !== undefined) {
    try {
      targetTsconfigPath = await resolveProjectFile(probePath, cwd);
    } catch {
      // fallback to cwd tsconfig
    }
  }
  const configHash = await computeEngineConfigHash("tsc", cwd, targetTsconfigPath);
  cache.invalidateEngine("tsc", configHash);
  const latestResult = cache.getEngineResult("tsc", configHash);
  const relevantSnapshots = snapshots.filter((snapshot) => isTypeScriptRelevant(snapshot.file));
  const misses = relevantSnapshots.filter((snapshot) => {
    const key = createCacheKey(snapshot.content, "tsc", configHash);
    return cache.get(key) === undefined;
  });

  if (latestResult !== undefined && misses.length === 0) {
    return {
      issues: latestResult,
      cache: { hits: relevantSnapshots.length, misses: 0 },
    };
  }

  const freshIssues = await runner({ cwd, signal, timeoutMs });
  for (const snapshot of relevantSnapshots) {
    const key = createCacheKey(snapshot.content, "tsc", configHash);
    cache.set(key, []);
  }
  cache.setEngineResult("tsc", configHash, freshIssues);
  return {
    issues: freshIssues,
    cache: {
      hits: relevantSnapshots.length - misses.length,
      misses: misses.length,
    },
  };
}

function sumCacheStats(stats: readonly CacheStats[]): CacheStats {
  return stats.reduce(
    (total, current) => ({
      hits: total.hits + current.hits,
      misses: total.misses + current.misses,
    }),
    { hits: 0, misses: 0 },
  );
}

async function readSnapshot(path: ResolvedProjectPath): Promise<FileSnapshot> {
  return {
    content: await readFile(path.absolutePath, "utf8"),
    file: path.relativePath,
  };
}

async function readConfig(configFile: string, cwd: string): Promise<string> {
  try {
    return await readFile(resolve(cwd, configFile), "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return "<missing>";
    }
    throw error;
  }
}

async function readConfigAbsolute(absolutePath: string): Promise<string> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return "<missing>";
    }
    throw error;
  }
}

/**
 * Recursively collects all tsconfig files reachable via extends and references
 * chains starting from rootPath. Bounded to 50 unique files to prevent cycles.
 */
async function collectTscConfigFiles(
  rootPath: string,
  visited: Set<string>,
): Promise<Set<string>> {
  if (visited.has(rootPath) || visited.size >= 50) {
    return visited;
  }
  visited.add(rootPath);

  const raw = await readConfigAbsolute(rootPath);
  if (raw === "<missing>") {
    return visited;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return visited;
  }

  if (!isRecord(parsed)) {
    return visited;
  }

  const baseDir = dirname(rootPath);
  const paths: string[] = [];

  if (typeof parsed.extends === "string") {
    paths.push(resolveExtends(parsed.extends, baseDir));
  } else if (Array.isArray(parsed.extends)) {
    for (const ext of parsed.extends) {
      if (typeof ext === "string") {
        paths.push(resolveExtends(ext, baseDir));
      }
    }
  }

  if (Array.isArray(parsed.references)) {
    for (const ref of parsed.references) {
      if (isRecord(ref) && typeof ref.path === "string") {
        const refPath = join(baseDir, ref.path);
        const candidate = refPath.endsWith(".json") ? refPath : join(refPath, "tsconfig.json");
        paths.push(candidate);
      }
    }
  }

  for (const childPath of paths) {
    await collectTscConfigFiles(childPath, visited);
  }
  return visited;
}

function resolveExtends(ext: string, baseDir: string): string {
  if (ext.startsWith(".")) {
    const joined = join(baseDir, ext);
    return joined.endsWith(".json") ? joined : `${joined}.json`;
  }
  // node_modules package reference — treat as opaque, include the literal string
  // as a stable sentinel so a package version change still invalidates the hash.
  return join(baseDir, "node_modules", ext, "tsconfig.json");
}

function relocateIssues(
  issues: readonly NormalizedIssue[],
  file: string,
): NormalizedIssue[] {
  return issues.map((issue) =>
    issue.file === file
      ? issue
      : {
          ...issue,
          issueId: createIssueId(file, issue.rule, issue.line, issue.message),
          file,
        },
  );
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!);
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function isTypeScriptRelevant(file: string): boolean {
  return ENGINE_REGISTRY.tsc.isRelevant(file);
}

function isOxlintRelevant(file: string): boolean {
  return ENGINE_REGISTRY.oxlint.isRelevant(file);
}

function isBiomeRelevant(file: string): boolean {
  return ENGINE_REGISTRY.biome.isRelevant(file);
}

function isEslintRelevant(file: string): boolean {
  return ENGINE_REGISTRY.eslint.isRelevant(file);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
