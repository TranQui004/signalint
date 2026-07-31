import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

const openCaches = new Set<SqliteCache>();

/** Creates the Section 9 cache key from file content, engine name, and engine config hash. */
export function createCacheKey(
  fileContent: string,
  engine: IssueEngine,
  configHash: string,
): string {
  const fileHash = createHash("sha256").update(fileContent).digest("hex");
  return `${fileHash}:${engine}:${configHash}`;
}

export class SqliteCache {
  private readonly database: Database.Database;
  private closed = false;

  /** Opens a SQLite cache and assumes its parent directory may be created when needed. */
  public constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new Database(databasePath);
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
    `);
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

    return parseIssues(row.result, "file cache");
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
      .run(key, JSON.stringify(issues), Date.now());
  }

  /** Deletes entries for an engine whose embedded config hash is not the current hash. */
  public invalidateEngine(engine: IssueEngine, currentConfigHash: string): number {
    const enginePattern = `%:${engine}:%`;
    const currentPattern = `%:${engine}:${currentConfigHash}`;
    const result = this.database
      .prepare("DELETE FROM cache WHERE key LIKE ? AND key NOT LIKE ?")
      .run(enginePattern, currentPattern);
    this.database
      .prepare("DELETE FROM engine_state WHERE engine = ? AND config_hash != ?")
      .run(engine, currentConfigHash);
    return result.changes;
  }

  /** Returns the latest whole-program result when its engine config hash is current. */
  public getEngineResult(
    engine: IssueEngine,
    configHash: string,
  ): NormalizedIssue[] | undefined {
    const row: unknown = this.database
      .prepare("SELECT result FROM engine_state WHERE engine = ? AND config_hash = ?")
      .get(engine, configHash);
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
      .run(engine, configHash, JSON.stringify(issues), Date.now());
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

function parseIssues(serialized: string, source: string): NormalizedIssue[] {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed) || !parsed.every(isNormalizedIssue)) {
    throw new Error(`SQLite cache contained an invalid ${source} Normalized Issue array.`);
  }
  return parsed;
}
