import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  isNormalizedIssue,
  type IssueEngine,
  type NormalizedIssue,
} from "../schema.js";

interface CacheRow {
  result: string;
}

interface EngineStateRow {
  result: string;
}

interface TimestampRow {
  timestamp: number;
}

export interface CacheVersionInfo {
  engineVersion: string;
  signalintVersion: string;
}

interface PackageMetadata {
  name?: string;
  version: string;
}

const ENGINE_PACKAGES: Record<IssueEngine, string> = {
  oxlint: "oxlint",
  tsc: "typescript",
  biome: "@biomejs/biome",
};

const openCaches = new Set<SqliteCache>();
const require = createRequire(import.meta.url);
const resolvedVersionInfo = new Map<IssueEngine, CacheVersionInfo>();
let installedSignalintVersion: string | undefined;

/** Maximum number of file-result rows retained by the default SQLite cache. */
export const DEFAULT_CACHE_ROW_LIMIT = 10_000;

/** Creates the Section 9 cache key including installed Signalint and engine versions. */
export function createCacheKey(
  fileContent: string,
  engine: IssueEngine,
  configHash: string,
  versions: CacheVersionInfo = resolveCacheVersionInfo(engine),
): string {
  const fileHash = createHash("sha256").update(fileContent).digest("hex");
  return createVersionedKey(fileHash, engine, configHash, versions);
}

/** Resolves installed package versions used to invalidate cache entries after upgrades. */
export function resolveCacheVersionInfo(engine: IssueEngine): CacheVersionInfo {
  const cached = resolvedVersionInfo.get(engine);
  if (cached !== undefined) {
    return cached;
  }
  const versions = {
    signalintVersion: resolveSignalintVersion(),
    engineVersion: readPackageVersion(require.resolve(`${ENGINE_PACKAGES[engine]}/package.json`)),
  };
  resolvedVersionInfo.set(engine, versions);
  return versions;
}

export class SqliteCache {
  private readonly database: Database.Database;
  private readonly maxRows: number;
  private lastAccessTimestamp: number;
  private closed = false;

  /** Opens a bounded SQLite cache and assumes its parent directory may be created. */
  public constructor(
    databasePath: string,
    maxRows: number = DEFAULT_CACHE_ROW_LIMIT,
  ) {
    if (!Number.isInteger(maxRows) || maxRows < 1) {
      throw new Error("SQLite cache maxRows must be a positive integer.");
    }
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new Database(databasePath);
    this.maxRows = maxRows;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        result JSON NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS engine_state (
        engine TEXT PRIMARY KEY,
        config_hash TEXT NOT NULL,
        result JSON NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS cache_timestamp ON cache(timestamp DESC);
    `);
    this.lastAccessTimestamp = this.readLatestTimestamp();
    this.evictOverflow();
    openCaches.add(this);
  }

  /** Returns cached normalized issues for an exact key, or undefined on a miss. */
  public get(key: string): NormalizedIssue[] | undefined {
    const row: unknown = this.database
      .prepare("SELECT result FROM cache WHERE key = ?")
      .get(key);
    if (row === undefined) {
      return undefined;
    }
    if (!isCacheRow(row)) {
      throw new Error("SQLite cache returned an invalid row.");
    }

    const issues = parseIssues(row.result, "file cache");
    this.database
      .prepare("UPDATE cache SET timestamp = ? WHERE key = ?")
      .run(this.nextAccessTimestamp(), key);
    return issues;
  }

  /** Upserts normalized issues under a cache key using the current epoch timestamp. */
  public set(key: string, issues: readonly NormalizedIssue[]): void {
    this.database
      .prepare(`
        INSERT INTO cache (key, result, timestamp)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          result = excluded.result,
          timestamp = excluded.timestamp
      `)
      .run(key, JSON.stringify(issues), this.nextAccessTimestamp());
    this.evictOverflow();
  }

  /** Deletes entries whose config, Signalint, or engine version is no longer current. */
  public invalidateEngine(
    engine: IssueEngine,
    currentConfigHash: string,
    versions: CacheVersionInfo = resolveCacheVersionInfo(engine),
  ): number {
    const enginePattern = `%:${engine}:%`;
    const currentPattern = `%:${createVersionedSuffix(engine, currentConfigHash, versions)}`;
    const result = this.database
      .prepare("DELETE FROM cache WHERE key LIKE ? AND key NOT LIKE ?")
      .run(enginePattern, currentPattern);
    this.database
      .prepare("DELETE FROM engine_state WHERE engine = ? AND config_hash != ?")
      .run(engine, createEngineStateHash(currentConfigHash, versions));
    return result.changes;
  }

  /** Returns the latest whole-program result when its engine config hash is current. */
  public getEngineResult(
    engine: IssueEngine,
    configHash: string,
    versions: CacheVersionInfo = resolveCacheVersionInfo(engine),
  ): NormalizedIssue[] | undefined {
    const row: unknown = this.database
      .prepare("SELECT result FROM engine_state WHERE engine = ? AND config_hash = ?")
      .get(engine, createEngineStateHash(configHash, versions));
    if (row === undefined) {
      return undefined;
    }
    if (!isEngineStateRow(row)) {
      throw new Error("SQLite cache returned an invalid engine state row.");
    }
    return parseIssues(row.result, "engine state");
  }

  /** Stores the latest whole-program result for an engine and its current config hash. */
  public setEngineResult(
    engine: IssueEngine,
    configHash: string,
    issues: readonly NormalizedIssue[],
    versions: CacheVersionInfo = resolveCacheVersionInfo(engine),
  ): void {
    this.database
      .prepare(`
        INSERT INTO engine_state (engine, config_hash, result, timestamp)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(engine) DO UPDATE SET
          config_hash = excluded.config_hash,
          result = excluded.result,
          timestamp = excluded.timestamp
      `)
      .run(
        engine,
        createEngineStateHash(configHash, versions),
        JSON.stringify(issues),
        Date.now(),
      );
  }

  /** Closes the underlying SQLite connection and assumes no later cache calls occur. */
  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    openCaches.delete(this);
    this.database.close();
  }

  private evictOverflow(): void {
    this.database
      .prepare(`
        DELETE FROM cache
        WHERE key IN (
          SELECT key
          FROM cache
          ORDER BY timestamp DESC, key DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(this.maxRows);
  }

  private nextAccessTimestamp(): number {
    this.lastAccessTimestamp = Math.max(Date.now(), this.lastAccessTimestamp + 1);
    return this.lastAccessTimestamp;
  }

  private readLatestTimestamp(): number {
    const row: unknown = this.database
      .prepare("SELECT COALESCE(MAX(timestamp), 0) AS timestamp FROM cache")
      .get();
    if (!isTimestampRow(row)) {
      throw new Error("SQLite cache returned an invalid timestamp row.");
    }
    return row.timestamp;
  }
}

/** Closes all SQLite handles still open during process shutdown. */
export function closeAllSqliteCaches(): void {
  for (const cache of openCaches) {
    try {
      cache.close();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[signalint] Failed to close SQLite cache: ${message}\n`);
    }
  }
}

function isCacheRow(value: unknown): value is CacheRow {
  return (
    typeof value === "object" &&
    value !== null &&
    "result" in value &&
    typeof value.result === "string"
  );
}

function isEngineStateRow(value: unknown): value is EngineStateRow {
  return isCacheRow(value);
}

function isTimestampRow(value: unknown): value is TimestampRow {
  return (
    typeof value === "object" &&
    value !== null &&
    "timestamp" in value &&
    typeof value.timestamp === "number"
  );
}

function parseIssues(serialized: string, source: string): NormalizedIssue[] {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed) || !parsed.every(isNormalizedIssue)) {
    throw new Error(`SQLite cache contained an invalid ${source} Normalized Issue array.`);
  }
  return parsed;
}

function createVersionedKey(
  fileHash: string,
  engine: IssueEngine,
  configHash: string,
  versions: CacheVersionInfo,
): string {
  return `${fileHash}:${createVersionedSuffix(engine, configHash, versions)}`;
}

function createVersionedSuffix(
  engine: IssueEngine,
  configHash: string,
  versions: CacheVersionInfo,
): string {
  return `${engine}:${configHash}:${versions.signalintVersion}:${versions.engineVersion}`;
}

function createEngineStateHash(
  configHash: string,
  versions: CacheVersionInfo,
): string {
  return createHash("sha256")
    .update(configHash)
    .update("\0")
    .update(versions.signalintVersion)
    .update("\0")
    .update(versions.engineVersion)
    .digest("hex");
}

function resolveSignalintVersion(): string {
  if (installedSignalintVersion !== undefined) {
    return installedSignalintVersion;
  }
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packagePath = resolve(directory, "package.json");
    try {
      const metadata = readPackageMetadata(packagePath);
      if (metadata.name === "signalint-mcp") {
        installedSignalintVersion = metadata.version;
        return installedSignalintVersion;
      }
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Could not resolve the installed signalint-mcp package version.");
    }
    directory = parent;
  }
}

function readPackageVersion(packagePath: string): string {
  return readPackageMetadata(packagePath).version;
}

function readPackageMetadata(packagePath: string): PackageMetadata {
  const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (
    !isRecord(parsed) ||
    typeof parsed.version !== "string" ||
    (parsed.name !== undefined && typeof parsed.name !== "string")
  ) {
    throw new Error(`Package metadata at ${packagePath} did not contain a valid version.`);
  }
  return parsed.name === undefined
    ? { version: parsed.version }
    : { name: parsed.name, version: parsed.version };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
