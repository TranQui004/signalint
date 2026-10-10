import type { IssueSeverity, NormalizedIssue } from "../schema.js";

export interface DiagnosticBufferOptions {
  maxCapacity?: number;
  debounceMs?: number;
}

export interface DiagnosticQueryFilter {
  files?: readonly string[] | undefined;
  severity?: IssueSeverity | undefined;
}

/** Generates a deduplication key based on (file, rule, line, col). */
export function getDiagnosticDeduplicationKey(issue: NormalizedIssue): string {
  return `${issue.file}\0${issue.rule}\0${issue.line}\0${issue.col}`;
}

/**
 * Manages an in-memory, bounded buffer of external LSP diagnostics with burst deduplication.
 */
export class DiagnosticBuffer {
  private readonly issuesByKey = new Map<string, NormalizedIssue>();
  private readonly maxCapacity: number;
  private readonly debounceMs: number;
  private debounceTimer?: NodeJS.Timeout | undefined;
  private settleResolvers: Array<() => void> = [];

  public constructor(options: DiagnosticBufferOptions = {}) {
    this.maxCapacity = options.maxCapacity ?? 10_000;
    this.debounceMs = options.debounceMs ?? 50;
  }

  /** Current number of active diagnostics in the buffer. */
  public get size(): number {
    return this.issuesByKey.size;
  }

  /** Ingests normalized diagnostics, deduplicating by (file, rule, line, col) and bounding capacity. */
  public ingest(issues: readonly NormalizedIssue[]): NormalizedIssue[] {
    for (const issue of issues) {
      const key = getDiagnosticDeduplicationKey(issue);
      // Delete and re-set to refresh insertion order for FIFO eviction
      this.issuesByKey.delete(key);
      this.issuesByKey.set(key, issue);
    }

    this.enforceCapacity();
    this.triggerDebounce();
    return Array.from(this.issuesByKey.values());
  }

  /** Returns all active diagnostics matching optional file and severity filters. */
  public getIssues(filter?: DiagnosticQueryFilter): NormalizedIssue[] {
    let result = Array.from(this.issuesByKey.values());

    if (filter?.files && filter.files.length > 0) {
      const allowed = new Set(filter.files);
      result = result.filter((issue) => allowed.has(issue.file));
    }

    if (filter?.severity) {
      result = result.filter((issue) => issue.severity === filter.severity);
    }

    return result;
  }

  /** Immediately settles active burst timers and returns all current issues. */
  public flush(): NormalizedIssue[] {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.resolveSettleWaiters();
    return Array.from(this.issuesByKey.values());
  }

  /** Waits until active debounce bursts settle, or resolves immediately if quiet. */
  public async settle(): Promise<NormalizedIssue[]> {
    if (this.debounceTimer === undefined) {
      return Array.from(this.issuesByKey.values());
    }
    await new Promise<void>((resolve) => {
      this.settleResolvers.push(resolve);
    });
    return Array.from(this.issuesByKey.values());
  }

  /** Removes all buffered diagnostics for a specific file. */
  public removeFile(file: string): void {
    const keysToDelete: string[] = [];
    for (const [key, issue] of this.issuesByKey.entries()) {
      if (issue.file === file) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.issuesByKey.delete(key);
    }
  }

  /** Clears all diagnostics and pending timers from the buffer. */
  public clear(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    this.issuesByKey.clear();
    this.resolveSettleWaiters();
  }

  /** Disposes resources and cancels pending timers. */
  public dispose(): void {
    this.clear();
  }

  private enforceCapacity(): void {
    while (this.issuesByKey.size > this.maxCapacity) {
      const oldestKey = this.issuesByKey.keys().next().value;
      if (oldestKey !== undefined) {
        this.issuesByKey.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  private triggerDebounce(): void {
    if (this.debounceMs <= 0) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.resolveSettleWaiters();
    }, this.debounceMs);
    // Unref timer so it does not block process exit
    if (typeof this.debounceTimer.unref === "function") {
      this.debounceTimer.unref();
    }
  }

  private resolveSettleWaiters(): void {
    const resolvers = this.settleResolvers.splice(0, this.settleResolvers.length);
    for (const resolve of resolvers) {
      resolve();
    }
  }
}
