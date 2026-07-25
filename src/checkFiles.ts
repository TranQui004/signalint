import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { runOxlint } from "./adapters/oxlint.js";
import { runTsc } from "./adapters/tsc.js";
import { createCacheKey, SqliteCache } from "./cache/sqliteCache.js";
import {
  createIssueId,
  type IssueEngine,
  type NormalizedIssue,
} from "./schema.js";

export type CacheEngine = Extract<IssueEngine, "oxlint" | "tsc">;

export interface EngineRunOptions {
  cwd?: string;
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
}

export interface CheckFilesOptions {
  cwd?: string;
  cache?: SqliteCache;
  runners?: EngineRunners;
}

interface FileSnapshot {
  content: string;
  file: string;
}

interface MissedFile extends FileSnapshot {
  key: string;
}

const ENGINE_CONFIG_FILES: Record<CacheEngine, readonly string[]> = {
  oxlint: [".oxlintrc", ".oxlintrc.json", "oxlint.json"],
  tsc: ["tsconfig.json"],
};

const DEFAULT_RUNNERS: EngineRunners = {
  oxlint: runOxlint,
  tsc: (options) => runTsc(["."], options),
};

/** Checks files through both engines, reusing SQLite entries for unchanged content and config. */
export async function checkFiles(
  files: readonly string[],
  options: CheckFilesOptions = {},
): Promise<NormalizedIssue[]> {
  const cwd = options.cwd ?? process.cwd();
  const cache = options.cache ?? new SqliteCache(resolve(cwd, ".signalint", "cache.sqlite"));
  const ownsCache = options.cache === undefined;

  try {
    const snapshots = await Promise.all(files.map((file) => readSnapshot(file, cwd)));
    const runners = options.runners ?? DEFAULT_RUNNERS;
    const results = await Promise.all([
      checkFileLocalEngine(
        "oxlint",
        snapshots.filter((snapshot) => isOxlintRelevant(snapshot.file)),
        cwd,
        cache,
        runners.oxlint,
      ),
      checkWholeProgramTsc(snapshots, cwd, cache, runners.tsc),
    ]);
    return results.flat().sort(compareIssues);
  } finally {
    if (ownsCache) {
      cache.close();
    }
  }
}

/** Hashes all recognized root config files for one engine, including missing-file markers. */
export async function computeEngineConfigHash(
  engine: CacheEngine,
  cwd: string,
): Promise<string> {
  const hash = createHash("sha256");
  for (const configFile of ENGINE_CONFIG_FILES[engine]) {
    hash.update(configFile);
    hash.update("\0");
    hash.update(await readConfig(configFile, cwd));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function checkFileLocalEngine(
  engine: CacheEngine,
  snapshots: readonly FileSnapshot[],
  cwd: string,
  cache: SqliteCache,
  runner: EngineRunner,
): Promise<NormalizedIssue[]> {
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
    return hits;
  }

  const freshIssues = await runner(
    misses.map((miss) => miss.file),
    { cwd },
  );
  for (const miss of misses) {
    const fileIssues = freshIssues.filter((issue) => issue.file === miss.file);
    cache.set(miss.key, fileIssues);
  }
  return [...hits, ...freshIssues];
}

async function checkWholeProgramTsc(
  snapshots: readonly FileSnapshot[],
  cwd: string,
  cache: SqliteCache,
  runner: WholeProgramRunner,
): Promise<NormalizedIssue[]> {
  const configHash = await computeEngineConfigHash("tsc", cwd);
  cache.invalidateEngine("tsc", configHash);
  const latestResult = cache.getEngineResult("tsc", configHash);
  const relevantSnapshots = snapshots.filter((snapshot) => isTypeScriptRelevant(snapshot.file));
  const misses = relevantSnapshots.filter((snapshot) => {
    const key = createCacheKey(snapshot.content, "tsc", configHash);
    return cache.get(key) === undefined;
  });

  if (latestResult !== undefined && misses.length === 0) {
    return latestResult;
  }

  const freshIssues = await runner({ cwd });
  for (const snapshot of relevantSnapshots) {
    const key = createCacheKey(snapshot.content, "tsc", configHash);
    cache.set(key, []);
  }
  cache.setEngineResult("tsc", configHash, freshIssues);
  return freshIssues;
}

async function readSnapshot(file: string, cwd: string): Promise<FileSnapshot> {
  const absoluteFile = isAbsolute(file) ? file : resolve(cwd, file);
  return {
    content: await readFile(absoluteFile, "utf8"),
    file: relative(cwd, absoluteFile).replaceAll("\\", "/"),
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

function compareIssues(left: NormalizedIssue, right: NormalizedIssue): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.col - right.col ||
    left.engine.localeCompare(right.engine)
  );
}

function isTypeScriptRelevant(file: string): boolean {
  return (
    /\.(?:[cm]?[jt]sx?|json)$/.test(file) ||
    file.endsWith("/package.json") ||
    file === "package.json"
  );
}

function isOxlintRelevant(file: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(file);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
