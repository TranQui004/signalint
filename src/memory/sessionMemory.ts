import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  CheckResponse,
  LoopStatus,
  LoopWarning,
  NormalizedIssue,
} from "../schema.js";

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
}

interface SessionLogEntry {
  timestamp: number;
  activeSignatures: string[];
  reappearedSignatures: string[];
  loopWarnings: LoopWarning[];
  metrics: SessionLogMetrics;
}

export class SessionMemory {
  private readonly appearanceTimestamps = new Map<string, number[]>();
  private activeSignatures = new Set<string>();
  private readonly logPath: string;
  private readonly now: () => number;

  /** Creates process-lifetime diagnostic memory with an append-only local session log. */
  public constructor(options: SessionMemoryOptions = {}) {
    this.logPath = options.logPath ?? resolve(process.cwd(), ".signalint", "session.jsonl");
    this.now = options.now ?? Date.now;
  }

  /** Records one check, its payload/cache metrics, and the current loop warning. */
  public async recordCheck(
    issues: readonly NormalizedIssue[],
    response: CheckResponse,
    cache: SessionCacheStats = { hits: 0, misses: 0 },
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
      metrics: createLogMetrics(issues, responseWithWarning, cache),
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
    await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

function createLogMetrics(
  issues: readonly NormalizedIssue[],
  response: CheckResponse,
  cache: SessionCacheStats,
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
