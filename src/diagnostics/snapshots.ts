import type { CacheStats } from "../checkFiles.js";
import type {
  Cluster,
  EngineStatuses,
  NormalizedIssue,
  RemainingIssue,
  StaleReferenceResponse,
} from "../schema.js";
import type { IssueReference } from "../toolArguments.js";

export interface DiagnosticSnapshot {
  checkId: string;
  projectRoot: string;
  timestamp: number;
  status: "clean" | "issues_found" | "error";
  issues: readonly NormalizedIssue[];
  clusters: readonly Cluster[];
  remainingIssues: readonly RemainingIssue[];
  totalIssues: number;
  omittedIssueCount: number;
  filteredOutIssueCount?: number | undefined;
  engines: EngineStatuses;
  cache?: CacheStats | undefined;
  source: "project" | "files" | "lsp";
  durationMs?: number | undefined;
}

export interface SnapshotStoreOptions {
  maxSnapshots?: number;
  ttlMs?: number;
  projectRoot?: string;
}

export class SnapshotStore {
  private readonly snapshots = new Map<string, DiagnosticSnapshot>();
  private readonly insertionOrder: string[] = [];
  private readonly expiredCheckIds = new Set<string>();
  private readonly maxSnapshots: number;
  private readonly ttlMs: number;
  public readonly projectRoot: string;

  public constructor(options: SnapshotStoreOptions = {}) {
    this.maxSnapshots = options.maxSnapshots ?? 50;
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.projectRoot = options.projectRoot ?? process.cwd();
  }

  /** Saves a new immutable snapshot and evicts older snapshots if capacity is exceeded. */
  public saveSnapshot(snapshot: DiagnosticSnapshot): void {
    this.pruneExpired();
    while (this.snapshots.size >= this.maxSnapshots && this.insertionOrder.length > 0) {
      const oldestId = this.insertionOrder.shift();
      if (oldestId !== undefined) {
        this.snapshots.delete(oldestId);
        this.recordExpired(oldestId);
      }
    }
    this.snapshots.set(snapshot.checkId, Object.freeze({ ...snapshot }));
    this.insertionOrder.push(snapshot.checkId);
  }

  /** Retrieves a snapshot by check ID, returning undefined if unknown or expired. */
  public getSnapshot(checkId: string): DiagnosticSnapshot | undefined {
    const snapshot = this.snapshots.get(checkId);
    if (!snapshot) {
      return undefined;
    }
    if (this.isSnapshotExpired(snapshot)) {
      this.snapshots.delete(checkId);
      this.recordExpired(checkId);
      const index = this.insertionOrder.indexOf(checkId);
      if (index !== -1) {
        this.insertionOrder.splice(index, 1);
      }
      return undefined;
    }
    return snapshot;
  }

  /** Returns the newest available non-expired snapshot, or undefined if the store is empty. */
  public getLatestSnapshot(): DiagnosticSnapshot | undefined {
    this.pruneExpired();
    for (let i = this.insertionOrder.length - 1; i >= 0; i--) {
      const id = this.insertionOrder[i];
      if (id !== undefined) {
        const snapshot = this.getSnapshot(id);
        if (snapshot !== undefined) {
          return snapshot;
        }
      }
    }
    return undefined;
  }

  /** Returns whether a checkId is known to have expired or been evicted from storage. */
  public isExpired(checkId: string): boolean {
    return this.expiredCheckIds.has(checkId);
  }

  /** Resolves issues for a reference from an explicit checkId or newest active snapshot. */
  public resolveIssues(
    reference: IssueReference,
    checkId?: string,
  ): NormalizedIssue[] | StaleReferenceResponse {
    const targetCheckId = checkId ?? reference.checkId;
    if (targetCheckId !== undefined) {
      const snapshot = this.getSnapshot(targetCheckId);
      if (!snapshot) {
        if (this.isExpired(targetCheckId)) {
          return {
            status: "stale",
            code: "snapshot_expired",
            message: `Diagnostic snapshot '${targetCheckId}' has expired; run check_project again.`,
          };
        }
        return {
          status: "stale",
          code: "unknown_check_id",
          message: `Check ID '${targetCheckId}' is unknown; run check_project again.`,
        };
      }
      return resolveIssuesInSnapshot(snapshot, reference);
    }

    const latest = this.getLatestSnapshot();
    if (!latest) {
      return {
        status: "stale",
        code: "unknown_check_id",
        message: "No diagnostic checks have been run in this session; run check_project first.",
      };
    }
    return resolveIssuesInSnapshot(latest, reference);
  }

  /** Returns count of active non-expired snapshots in store. */
  public size(): number {
    this.pruneExpired();
    return this.snapshots.size;
  }

  /** Clears all stored snapshots and expired markers. */
  public clear(): void {
    this.snapshots.clear();
    this.insertionOrder.length = 0;
    this.expiredCheckIds.clear();
  }

  private isSnapshotExpired(snapshot: DiagnosticSnapshot): boolean {
    return Date.now() - snapshot.timestamp > this.ttlMs;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, snapshot] of this.snapshots.entries()) {
      if (now - snapshot.timestamp > this.ttlMs) {
        this.snapshots.delete(id);
        this.recordExpired(id);
        const index = this.insertionOrder.indexOf(id);
        if (index !== -1) {
          this.insertionOrder.splice(index, 1);
        }
      }
    }
  }

  private recordExpired(id: string): void {
    this.expiredCheckIds.add(id);
    if (this.expiredCheckIds.size > 200) {
      const oldest = this.expiredCheckIds.values().next().value;
      if (oldest !== undefined) {
        this.expiredCheckIds.delete(oldest);
      }
    }
  }
}

/** Resolves issues matching a reference within an immutable snapshot. */
export function resolveIssuesInSnapshot(
  snapshot: DiagnosticSnapshot,
  reference: IssueReference,
): NormalizedIssue[] | StaleReferenceResponse {
  if ("clusterId" in reference) {
    const matches = snapshot.issues.filter((issue) => issue.clusterId === reference.clusterId);
    return matches.length === 0
      ? {
          status: "stale",
          message: "This cluster/issue no longer exists; run check_project again.",
        }
      : matches;
  }
  const exact = snapshot.issues.filter((issue) => issue.issueId === reference.issueId);
  if (exact.length > 0) {
    return exact;
  }
  const prefixMatches = snapshot.issues.filter((issue) => issue.issueId.startsWith(reference.issueId));
  return prefixMatches.length === 0
    ? {
        status: "stale",
        message: "This cluster/issue no longer exists; run check_project again.",
      }
    : prefixMatches;
}
