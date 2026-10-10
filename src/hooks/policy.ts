import { checkFilesWithStats, type CheckFilesResult } from "../checkFiles.js";
import { collectProjectIssueResult, type IssueProviderResult } from "../check/checkProject.js";
import { clusterIssues } from "../cluster/clusterEngine.js";
import type { EngineStatuses, NormalizedIssue, RemainingIssue } from "../schema.js";
import type { NormalizedHookEvent, HookDecision, HookDecisionAction } from "./event.js";

export interface HookPolicyOptions {
  cwd?: string | undefined;
  failOnPriority?: number | undefined;
  maxSummaryIssues?: number | undefined;
  scopedChecker?: ((files: readonly string[], cwd: string) => Promise<CheckFilesResult>) | undefined;
  projectChecker?: ((cwd: string) => Promise<IssueProviderResult>) | undefined;
}

const DEFAULT_MAX_SUMMARY_ISSUES = 5;

/** Executes the unified verification policy for a normalized hook event and emits a bounded decision. */
export async function executeHookPolicy(
  event: NormalizedHookEvent,
  options: HookPolicyOptions = {},
): Promise<HookDecision> {
  const cwd = options.cwd ?? event.cwd ?? process.cwd();
  const maxIssues = options.maxSummaryIssues ?? DEFAULT_MAX_SUMMARY_ISSUES;

  if (event.eventType === "post_edit") {
    return await executePostEditPolicy(event, cwd, maxIssues, options);
  }
  return await executeStopPolicy(cwd, maxIssues, options);
}

async function executePostEditPolicy(
  event: NormalizedHookEvent,
  cwd: string,
  maxIssues: number,
  options: HookPolicyOptions,
): Promise<HookDecision> {
  if (event.files.length === 0) {
    return {
      action: "approve",
      status: "clean",
      totalIssues: 0,
      omittedCount: 0,
      summary: "Signalint: No relevant code files to check.",
    };
  }

  const checkResult = options.scopedChecker !== undefined
    ? await options.scopedChecker(event.files, cwd)
    : await checkFilesWithStats(event.files, { cwd });

  const clustered = clusterIssues(checkResult.issues, 5, checkResult.engines, cwd, {
    filteredOutIssueCount: checkResult.filteredOutIssueCount,
  });

  const engineFailures = detectEngineFailures(checkResult.engines);
  const totalIssues = clustered.response.totalIssues;
  const remaining = clustered.response.remainingIssues ?? [];

  if (totalIssues === 0 && engineFailures.length === 0) {
    return {
      action: "approve",
      status: "clean",
      totalIssues: 0,
      omittedCount: 0,
      summary: "Signalint: 0 issues found. Code is clean.",
    };
  }

  const summary = formatBoundedSummary(
    clustered.response.totalIssues,
    checkResult.issues,
    maxIssues,
    engineFailures,
  );

  const shouldBlock = options.failOnPriority !== undefined &&
    isPriorityThresholdExceeded(remaining, options.failOnPriority);

  const action: HookDecisionAction = shouldBlock ? "block" : "approve";

  return {
    action,
    status: engineFailures.length > 0 ? "error" : "issues_found",
    totalIssues,
    omittedCount: Math.max(0, totalIssues - maxIssues),
    summary,
    reason: shouldBlock ? summary : undefined,
    additionalContext: summary,
    followupMessage: summary,
    engineFailures: engineFailures.length > 0 ? engineFailures : undefined,
  };
}

async function executeStopPolicy(
  cwd: string,
  maxIssues: number,
  options: HookPolicyOptions,
): Promise<HookDecision> {
  const checkResult = options.projectChecker !== undefined
    ? await options.projectChecker(cwd)
    : await collectProjectIssueResult(["."], cwd);

  const clustered = clusterIssues(checkResult.issues, 5, checkResult.engines, cwd, {
    filteredOutIssueCount: checkResult.filteredOutIssueCount,
  });

  const engineFailures = detectEngineFailures(checkResult.engines);
  const totalIssues = clustered.response.totalIssues;
  const remaining = clustered.response.remainingIssues ?? [];

  // Stop policy defaults to blocking on Priority 1 (errors) or engine failures
  const threshold = options.failOnPriority ?? 1;
  const hasThresholdErrors = isPriorityThresholdExceeded(remaining, threshold);

  if (engineFailures.length > 0) {
    const summary = formatBoundedSummary(totalIssues, checkResult.issues, maxIssues, engineFailures);
    return {
      action: "block",
      status: "error",
      totalIssues,
      omittedCount: Math.max(0, totalIssues - maxIssues),
      summary,
      reason: `Verification failed: Diagnostic engine(s) failed (${engineFailures.join(", ")}).`,
      additionalContext: summary,
      followupMessage: summary,
      engineFailures,
    };
  }

  if (hasThresholdErrors) {
    const summary = formatBoundedSummary(totalIssues, checkResult.issues, maxIssues, engineFailures);
    return {
      action: "block",
      status: "issues_found",
      totalIssues,
      omittedCount: Math.max(0, totalIssues - maxIssues),
      summary,
      reason: `Verification failed: ${String(totalIssues)} unresolved issue(s) remaining at priority <= ${String(threshold)}.`,
      additionalContext: summary,
      followupMessage: summary,
    };
  }

  if (totalIssues > 0) {
    // Non-blocking issues remaining at stop
    const summary = formatBoundedSummary(totalIssues, checkResult.issues, maxIssues, engineFailures);
    return {
      action: "approve",
      status: "issues_found",
      totalIssues,
      omittedCount: Math.max(0, totalIssues - maxIssues),
      summary,
      additionalContext: summary,
    };
  }

  return {
    action: "approve",
    status: "clean",
    totalIssues: 0,
    omittedCount: 0,
    summary: "Signalint: All project diagnostics clean.",
  };
}

/** Formats a bounded human-readable issue summary with an exact omission count. */
export function formatBoundedSummary(
  totalIssues: number,
  issues: readonly (RemainingIssue | NormalizedIssue)[],
  maxIssues: number,
  engineFailures: readonly string[],
): string {
  const lines: string[] = [];

  if (engineFailures.length > 0) {
    lines.push(`[Signalint Warning] Diagnostic engine failure: ${engineFailures.join(", ")}`);
  }

  lines.push(`Signalint found ${String(totalIssues)} diagnostic issue${totalIssues === 1 ? "" : "s"}:`);

  const displayCount = Math.min(issues.length, maxIssues);
  for (let i = 0; i < displayCount; i++) {
    const issue = issues[i];
    if (issue !== undefined) {
      const loc = `${issue.file}:${String(issue.line)}:${String(issue.col)}`;
      const severity = issue.severity.toUpperCase();
      const message = "message" in issue && typeof (issue as { message?: unknown }).message === "string"
        ? `: ${(issue as { message: string }).message}`
        : "";
      lines.push(`  • [${severity}] ${loc} (${issue.rule})${message}`);
    }
  }

  const omitted = totalIssues - displayCount;
  if (omitted > 0) {
    lines.push(`  (... and ${String(omitted)} more issue${omitted === 1 ? "" : "s"} omitted)`);
  }

  return lines.join("\n");
}

function detectEngineFailures(engines: EngineStatuses): string[] {
  const failures: string[] = [];
  for (const [engine, status] of Object.entries(engines)) {
    if (status && status.status === "error") {
      failures.push(engine);
    }
  }
  return failures;
}

function isPriorityThresholdExceeded(
  remaining: readonly RemainingIssue[],
  threshold: number,
): boolean {
  return remaining.some((issue) => {
    const priority = issue.priority ?? (issue.severity === "error" ? 1 : 2);
    return priority <= threshold;
  });
}
