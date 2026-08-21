import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type {
  CheckResponse,
  FileRuleChurnWarning,
  LoopStatus,
  LoopWarning,
  NormalizedIssue,
} from "../schema.js";
import {
  parseSessionJsonLines,
  type ParsedSessionLogEntry,
} from "../sessionLog.js";
import {
  readSessionLogTail,
  rotateSessionLogIfNeeded,
} from "./sessionLogStorage.js";

/** Maximum number of recent checks replayed into loop memory on startup. */
export const DEFAULT_SESSION_REPLAY_LIMIT = 5_000;

/** Active session-log size that triggers bounded rotation before an append. */
export const DEFAULT_SESSION_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Number of distinct check_files calls to the same (file, rule) pair before a churn warning is emitted. */
export const FILE_RULE_CHURN_THRESHOLD = 3;

export interface SessionMemoryOptions {
  logPath?: string;
  maxLogBytes?: number;
  maxReplayEntries?: number;
  now?: () => number;
}

export interface SessionCacheStats {
  hits: number;
  misses: number;
}

/** Whether a check was a full-project scan or an incremental file check. */
export type CheckSource = "project" | "files";

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
  activeFileRulePairs: string[];
  reappearedSignatures: string[];
  loopWarnings: LoopWarning[];
  metrics: SessionLogMetrics;
}

interface SessionReplayEntry {
  timestamp: number;
  activeSignatures: string[];
  activeFileRulePairs: string[];
}

interface SessionHistory {
  entries: SessionReplayEntry[];
  malformedLinesSkipped: number;
  needsLineBoundary: boolean;
}

interface RestoredSessionState {
  appearanceTimestamps: Map<string, number[]>;
  activeSignatures: Set<string>;
  churnCounts: Map<string, number>;
  activeFileRulePairs: Set<string>;
}

export class SessionMemory {
  private readonly appearanceTimestamps: Map<string, number[]>;
  private activeSignatures: Set<string>;
  /** Counts distinct check_files calls that produced each (file, rule) pair. Reset to 0 on absence. */
  private readonly churnCounts: Map<string, number>;
  private activeFileRulePairs: Set<string>;
  private readonly logPath: string;
  private readonly maxLogBytes: number;
  private readonly maxReplayEntries: number;
  private readonly now: () => number;
  private needsLineBoundary: boolean;

  /** Creates diagnostic memory restored from valid entries in its append-only session log. */
  public constructor(options: SessionMemoryOptions = {}) {
    this.logPath = options.logPath ?? resolve(process.cwd(), ".signalint", "session.jsonl");
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_SESSION_LOG_MAX_BYTES;
    this.maxReplayEntries = options.maxReplayEntries ?? DEFAULT_SESSION_REPLAY_LIMIT;
    assertPositiveInteger(this.maxLogBytes, "maxLogBytes");
    assertPositiveInteger(this.maxReplayEntries, "maxReplayEntries");
    this.now = options.now ?? Date.now;
    const history = readSessionHistory(
      this.logPath,
      this.maxReplayEntries,
      this.maxLogBytes,
    );
    if (history.malformedLinesSkipped > 0) {
      process.stderr.write(
        `[signalint] Skipped ${String(history.malformedLinesSkipped)} malformed session log line(s).\n`,
      );
    }
    const restored = restoreSessionState(history.entries);
    this.appearanceTimestamps = restored.appearanceTimestamps;
    this.activeSignatures = restored.activeSignatures;
    this.churnCounts = restored.churnCounts;
    this.activeFileRulePairs = restored.activeFileRulePairs;
    this.needsLineBoundary = history.needsLineBoundary;
  }

  /** Records one check, its payload/cache metrics, and the current loop warning. */
  public async recordCheck(
    issues: readonly NormalizedIssue[],
    response: CheckResponse,
    cache: SessionCacheStats = { hits: 0, misses: 0 },
    startedAt: number = performance.now(),
    source: CheckSource = "project",
  ): Promise<CheckResponse> {
    const timestamp = this.now();
    const currentSignatures = new Set(issues.map(createIssueSignature));
    const reappearedSignatures = this.recordAppearances(currentSignatures, timestamp);
    this.activeSignatures = currentSignatures;

    let currentFileRulePairs = new Set<string>();
    if (source === "files") {
      currentFileRulePairs = new Set(issues.map(createFileRuleKey));
      this.updateChurnCounts(currentFileRulePairs);
    }

    const status = this.getStatus();
    const responseWithWarning: CheckResponse = {
      ...response,
      loopWarning: status.signatures[0] ?? null,
      fileRuleChurnWarning: status.fileRuleChurns[0] ?? null,
    };
    await this.appendLog({
      timestamp,
      activeSignatures: [...currentSignatures].sort(),
      activeFileRulePairs: [...currentFileRulePairs].sort(),
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

  /** Returns all signatures that disappeared and reappeared at least twice this session, plus all file/rule pairs that have triggered across 3+ check_files calls. */
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

    const fileRuleChurns: FileRuleChurnWarning[] = [];
    for (const [key, count] of this.churnCounts) {
      if (count >= FILE_RULE_CHURN_THRESHOLD) {
        fileRuleChurns.push(createFileRuleChurnWarning(key, count));
      }
    }
    fileRuleChurns.sort(
      (left, right) =>
        right.checkCount - left.checkCount ||
        left.file.localeCompare(right.file) ||
        left.rule.localeCompare(right.rule),
    );

    return {
      looping: signatures.length > 0,
      signatures,
      fileChurning: fileRuleChurns.length > 0,
      fileRuleChurns,
    };
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

  private updateChurnCounts(currentPairs: Set<string>): void {
    // Increment for pairs present in this call.
    for (const key of currentPairs) {
      this.churnCounts.set(key, (this.churnCounts.get(key) ?? 0) + 1);
    }
    // Reset to 0 for tracked pairs absent from this call.
    for (const [key, count] of this.churnCounts) {
      if (count > 0 && !currentPairs.has(key)) {
        this.churnCounts.set(key, 0);
      }
    }
    this.activeFileRulePairs = currentPairs;
  }

  private async appendLog(entry: SessionLogEntry): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
    const serializedEntry = `${JSON.stringify(entry)}\n`;
    let prefix = this.needsLineBoundary ? "\n" : "";
    const rotated = await rotateSessionLogIfNeeded(
      this.logPath,
      Buffer.byteLength(`${prefix}${serializedEntry}`, "utf8"),
      this.maxReplayEntries,
      this.maxLogBytes,
    );
    if (rotated) {
      this.needsLineBoundary = false;
      prefix = "";
    }
    await appendFile(this.logPath, `${prefix}${serializedEntry}`, "utf8");
    this.needsLineBoundary = false;
  }
}

function readSessionHistory(
  logPath: string,
  maxEntries: number,
  maxBytes: number,
): SessionHistory {
  const tail = readSessionLogTail(logPath, maxEntries, maxBytes);
  if (tail === undefined) {
    return { entries: [], malformedLinesSkipped: 0, needsLineBoundary: false };
  }
  const parsedLog = parseSessionJsonLines(tail.serialized);
  return {
    entries: parsedLog.entries
      .map(parseSessionReplayEntry)
      .filter((entry): entry is SessionReplayEntry => entry !== undefined),
    malformedLinesSkipped: parsedLog.malformedLinesSkipped,
    needsLineBoundary: tail.serialized !== "" && !tail.endsWithNewline,
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
    activeFileRulePairs: parsed.activeFileRulePairs ?? [],
  };
}

function restoreSessionState(entries: readonly SessionReplayEntry[]): RestoredSessionState {
  const appearanceTimestamps = new Map<string, number[]>();
  const churnCounts = new Map<string, number>();
  let previousSignatures = new Set<string>();
  let previousFileRulePairs = new Set<string>();
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

    // Replay churn counts from activeFileRulePairs entries.
    // Only entries that recorded file-rule pairs (source=files) will have non-empty arrays.
    if (entry.activeFileRulePairs.length > 0 || previousFileRulePairs.size > 0) {
      const currentPairs = new Set(entry.activeFileRulePairs);
      for (const key of currentPairs) {
        churnCounts.set(key, (churnCounts.get(key) ?? 0) + 1);
      }
      for (const [key, count] of churnCounts) {
        if (count > 0 && !currentPairs.has(key)) {
          churnCounts.set(key, 0);
        }
      }
      previousFileRulePairs = currentPairs;
    }
  }
  return {
    appearanceTimestamps,
    activeSignatures: previousSignatures,
    churnCounts,
    activeFileRulePairs: previousFileRulePairs,
  };
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

/** Creates the file-rule pair key used for churn detection. Uses \0 as separator to prevent collisions. */
export function createFileRuleKey(issue: NormalizedIssue): string {
  return `${issue.file}\0${issue.rule}`;
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

function createFileRuleChurnWarning(key: string, checkCount: number): FileRuleChurnWarning {
  const separatorIndex = key.indexOf("\0");
  const file = key.slice(0, separatorIndex);
  const rule = key.slice(separatorIndex + 1);
  return {
    file,
    rule,
    checkCount,
    hint: `${file} has re-triggered ${rule} across ${String(checkCount)} separate checks — the agent may be stuck on this file, not just this exact issue`,
  };
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`SessionMemory ${name} must be a positive integer.`);
  }
}
