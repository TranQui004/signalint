import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type {
  CheckResponse,
  LoopStatus,
  LoopWarning,
  NormalizedIssue,
} from "../schema.js";
import {
  parseSessionJsonLines,
  type ParsedSessionLogEntry,
} from "../sessionLog.js";

export interface SessionMemoryOptions {
  logPath?: string;
  now?: () => number;
}

export interface SessionCacheStats {
  hits: number;
  misses: number;
}

interface SessionLogMetrics {
  rawPayloadBytes: number;
  clusteredPayloadBytes: number;
  cacheHits: number;
  cacheMisses: number;
  latencyMs: number;
}

interface SessionLogEntry {
  timestamp: number;
  activeSignatures: string[];
  reappearedSignatures: string[];
  loopWarnings: LoopWarning[];
  metrics: SessionLogMetrics;
}

interface SessionReplayEntry {
  timestamp: number;
  activeSignatures: string[];
}

interface SessionHistory {
  entries: SessionReplayEntry[];
  malformedLinesSkipped: number;
  needsLineBoundary: boolean;
}

interface RestoredSessionState {
  appearanceTimestamps: Map<string, number[]>;
  activeSignatures: Set<string>;
}

export class SessionMemory {
  private readonly appearanceTimestamps: Map<string, number[]>;
  private activeSignatures: Set<string>;
  private readonly logPath: string;
  private readonly now: () => number;
  private needsLineBoundary: boolean;

  /** Creates diagnostic memory restored from valid entries in its append-only session log. */
  public constructor(options: SessionMemoryOptions = {}) {
    this.logPath = options.logPath ?? resolve(process.cwd(), ".signalint", "session.jsonl");
    this.now = options.now ?? Date.now;
    const history = readSessionHistory(this.logPath);
    if (history.malformedLinesSkipped > 0) {
      process.stderr.write(
        `[signalint] Skipped ${String(history.malformedLinesSkipped)} malformed session log line(s).\n`,
      );
    }
    const restored = restoreSessionState(history.entries);
    this.appearanceTimestamps = restored.appearanceTimestamps;
    this.activeSignatures = restored.activeSignatures;
    this.needsLineBoundary = history.needsLineBoundary;
  }

  /** Records one check, its payload/cache metrics, and the current loop warning. */
  public async recordCheck(
    issues: readonly NormalizedIssue[],
    response: CheckResponse,
    cache: SessionCacheStats = { hits: 0, misses: 0 },
    startedAt: number = performance.now(),
  ): Promise<CheckResponse> {
    const timestamp = this.now();
    const currentSignatures = new Set(issues.map(createIssueSignature));
    const reappearedSignatures = this.recordAppearances(currentSignatures, timestamp);
    this.activeSignatures = currentSignatures;
    const status = this.getStatus();
    const responseWithWarning: CheckResponse = {
      ...response,
      loopWarning: status.signatures[0] ?? null,
    };
    await this.appendLog({
      timestamp,
      activeSignatures: [...currentSignatures].sort(),
      reappearedSignatures,
      loopWarnings: status.signatures,
      metrics: createLogMetrics(
        issues,
        responseWithWarning,
        cache,
        Math.max(0, performance.now() - startedAt),
      ),
    });
    return responseWithWarning;
  }

  /** Returns all signatures that disappeared and reappeared at least twice this session. */
  public getStatus(): LoopStatus {
    const signatures: LoopWarning[] = [];
    for (const [signature, timestamps] of this.appearanceTimestamps) {
      const occurrences = timestamps.length - 1;
      if (occurrences >= 2) {
        signatures.push(createLoopWarning(signature, occurrences));
      }
    }
    signatures.sort(
      (left, right) =>
        right.occurrences - left.occurrences || left.signature.localeCompare(right.signature),
    );
    return { looping: signatures.length > 0, signatures };
  }

  private recordAppearances(current: Set<string>, timestamp: number): string[] {
    const reappeared: string[] = [];
    for (const signature of current) {
      if (this.activeSignatures.has(signature)) {
        continue;
      }
      const timestamps = this.appearanceTimestamps.get(signature);
      if (timestamps === undefined) {
        this.appearanceTimestamps.set(signature, [timestamp]);
      } else {
        timestamps.push(timestamp);
        reappeared.push(signature);
      }
    }
    return reappeared.sort();
  }

  private async appendLog(entry: SessionLogEntry): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
    const prefix = this.needsLineBoundary ? "\n" : "";
    await appendFile(this.logPath, `${prefix}${JSON.stringify(entry)}\n`, "utf8");
    this.needsLineBoundary = false;
  }
}

function readSessionHistory(logPath: string): SessionHistory {
  let serialized: string;
  try {
    serialized = readFileSync(logPath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return { entries: [], malformedLinesSkipped: 0, needsLineBoundary: false };
    }
    throw error;
  }
  const parsedLog = parseSessionJsonLines(serialized);
  return {
    entries: parsedLog.entries
      .map(parseSessionReplayEntry)
      .filter((entry): entry is SessionReplayEntry => entry !== undefined),
    malformedLinesSkipped: parsedLog.malformedLinesSkipped,
    needsLineBoundary: serialized !== "" && !serialized.endsWith("\n"),
  };
}

function parseSessionReplayEntry(parsed: ParsedSessionLogEntry): SessionReplayEntry | undefined {
  if (
    parsed.timestamp === undefined ||
    parsed.activeSignatures === undefined
  ) {
    return undefined;
  }
  return {
    timestamp: parsed.timestamp,
    activeSignatures: parsed.activeSignatures,
  };
}

function restoreSessionState(entries: readonly SessionReplayEntry[]): RestoredSessionState {
  const appearanceTimestamps = new Map<string, number[]>();
  let previousSignatures = new Set<string>();
  for (const entry of entries) {
    const currentSignatures = new Set(entry.activeSignatures);
    for (const signature of currentSignatures) {
      if (!previousSignatures.has(signature)) {
        const timestamps = appearanceTimestamps.get(signature) ?? [];
        timestamps.push(entry.timestamp);
        appearanceTimestamps.set(signature, timestamps);
      }
    }
    previousSignatures = currentSignatures;
  }
  return { appearanceTimestamps, activeSignatures: previousSignatures };
}

function createLogMetrics(
  issues: readonly NormalizedIssue[],
  response: CheckResponse,
  cache: SessionCacheStats,
  latencyMs: number,
): SessionLogMetrics {
  return {
    rawPayloadBytes: issues.length === 0
      ? 0
      : Buffer.byteLength(
          JSON.stringify(issues, (key, value: unknown) =>
            key === "clusterId" ? undefined : value,
          ),
          "utf8",
        ),
    clusteredPayloadBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
    cacheHits: cache.hits,
    cacheMisses: cache.misses,
    latencyMs,
  };
}

/** Creates the narrow rule-plus-message signature used only for diagnostic loop detection. */
export function createIssueSignature(issue: NormalizedIssue): string {
  return `${issue.rule}:${normalizeSignatureMessage(issue.message)}`;
}

/** Removes changing identifier and numeric details from a diagnostic message. */
export function normalizeSignatureMessage(message: string): string {
  return message
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "<identifier>")
    .replace(
      /\b(variable|identifier|name|property|parameter|argument)\s+([A-Za-z_$][\w$]*)/gi,
      "$1 <identifier>",
    )
    .replace(/\b(line|column|col)\s+\d+\b/gi, "$1 <number>")
    .replace(/\b\d+\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function createLoopWarning(signature: string, occurrences: number): LoopWarning {
  return {
    signature,
    occurrences,
    hint: `This issue was fixed and reappeared ${String(occurrences)} times — consider a different approach`,
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
