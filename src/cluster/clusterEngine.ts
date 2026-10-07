import { createHash } from "node:crypto";

import type {
  CheckResponse,
  Cluster,
  EngineStatus,
  EngineStatuses,
  IssueEngine,
  NormalizedIssue,
  RemainingIssue,
} from "../schema.js";
import { createDefaultEngineStatuses } from "../schema.js";
import { compareIssues } from "../util/index.js";

export interface ClusterResult {
  issues: NormalizedIssue[];
  response: CheckResponse;
}

interface PendingCluster {
  issues: NormalizedIssue[];
  priority: number;
  rule: string;
  systemic: boolean;
}

export interface ClusterOptions {
  compact?: boolean | undefined;
  filteredOutIssueCount?: number | undefined;
}

const MAX_REMAINING_ISSUES = 100;

/** Clusters raw issues with schema 1.4 bounded clusters and remaining flat records. */
export function clusterIssues(
  rawIssues: readonly NormalizedIssue[],
  maxClusters: number = 10,
  engines: EngineStatuses = createDefaultEngineStatuses(),
  projectRoot: string = process.cwd(),
  options: ClusterOptions = {},
): ClusterResult {
  if (!Number.isInteger(maxClusters) || maxClusters < 1) {
    throw new Error("maxClusters must be a positive integer.");
  }

  const { multiIssueClusters, singleIssues } = partitionIssues(rawIssues);
  multiIssueClusters.sort(comparePendingClusters);

  const topClusters = multiIssueClusters.slice(0, maxClusters);
  const overflowClusters = multiIssueClusters.slice(maxClusters);
  const demotedIssues = overflowClusters.flatMap((c) => c.issues);

  const issueClusterIds = new Map<string, string>();
  const collisionCounts = new Map<string, number>();
  const clusters = topClusters.map((pending) =>
    buildCluster(pending, collisionCounts, issueClusterIds),
  );

  const issues = rawIssues.map((issue) => {
    const clusterId = issueClusterIds.get(issue.issueId);
    return clusterId !== undefined ? { ...issue, clusterId } : { ...issue };
  });

  const allRemaining = [...singleIssues, ...demotedIssues].sort(compareRemainingIssues);
  const { remainingIssues, omittedIssueCount, nextStep, truncated } =
    formatRemaining(allRemaining);

  const statusInfo = determineStatus(engines, rawIssues.length);
  const isCompact = options.compact ?? (process.env.SIGNALINT_COMPACT === "1");

  const filteredOutIssueCount = options.filteredOutIssueCount ?? 0;
  let effectiveNextStep = nextStep;
  if (filteredOutIssueCount > 0) {
    const hint = `Run check_project to inspect ${String(filteredOutIssueCount)} issue(s) outside requested files.`;
    effectiveNextStep = nextStep !== undefined ? `${nextStep} ${hint}` : hint;
  }

  const response: CheckResponse = isCompact
    ? ({
        v: "1.4",
        status: statusInfo.status,
        engines: trimEngines(engines),
        total: rawIssues.length,
        clusters,
        remaining: remainingIssues,
        ...(omittedIssueCount !== undefined ? { omitted: omittedIssueCount } : {}),
        ...(filteredOutIssueCount > 0 ? { filteredOut: filteredOutIssueCount } : {}),
        ...(effectiveNextStep !== undefined ? { nextStep: effectiveNextStep } : {}),
        truncated,
        checkId: computeCheckId(rawIssues),
        ...(statusInfo.code !== undefined ? { code: statusInfo.code } : {}),
        ...(statusInfo.message !== undefined ? { message: statusInfo.message } : {}),
      } as unknown as CheckResponse)
    : {
        schemaVersion: "1.4",
        status: statusInfo.status,
        projectRoot,
        engines: trimEngines(engines),
        totalIssues: rawIssues.length,
        clusters,
        remainingIssues,
        ...(omittedIssueCount !== undefined ? { omittedIssueCount } : {}),
        ...(filteredOutIssueCount > 0
          ? {
              filteredOutIssueCount,
              filteredOutCount: filteredOutIssueCount,
            }
          : {}),
        ...(effectiveNextStep !== undefined ? { nextStep: effectiveNextStep } : {}),
        truncated,
        checkId: computeCheckId(rawIssues),
        ...(statusInfo.code !== undefined ? { code: statusInfo.code } : {}),
        ...(statusInfo.message !== undefined ? { message: statusInfo.message } : {}),
      };

  return { issues, response };
}

function partitionIssues(rawIssues: readonly NormalizedIssue[]): {
  multiIssueClusters: PendingCluster[];
  singleIssues: NormalizedIssue[];
} {
  const groups = groupByRule(rawIssues);
  const multiIssueClusters: PendingCluster[] = [];
  const singleIssues: NormalizedIssue[] = [];

  for (const rule of [...groups.keys()].sort()) {
    const issues = [...(groups.get(rule) ?? [])].sort(compareIssues);
    if (issues.length >= 2) {
      const systemic = issues.length > 3 && countFiles(issues) > 2;
      multiIssueClusters.push({
        issues,
        priority: scorePriority(issues, systemic),
        rule,
        systemic,
      });
    } else {
      singleIssues.push(...issues);
    }
  }

  return { multiIssueClusters, singleIssues };
}

function buildCluster(
  pending: PendingCluster,
  collisionCounts: Map<string, number>,
  issueClusterIds: Map<string, string>,
): Cluster {
  const severity = pending.issues.some((i) => i.severity === "error") ? "error" : "warning";
  const ruleKey = [...new Set(pending.issues.map((i) => i.rule))].sort().join("");
  const key = `${ruleKey}|${severity}|${String(pending.systemic)}`;
  const baseHash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  const baseId = `c${baseHash}`;
  const collisionIndex = collisionCounts.get(baseId) ?? 0;
  collisionCounts.set(baseId, collisionIndex + 1);
  const clusterId = collisionIndex === 0 ? baseId : `${baseId}-${String(collisionIndex)}`;

  for (const issue of pending.issues) {
    issueClusterIds.set(issue.issueId, clusterId);
  }
  return createCluster(pending, clusterId);
}

function formatRemaining(allRemaining: NormalizedIssue[]): {
  remainingIssues: RemainingIssue[];
  omittedIssueCount: number;
  nextStep?: string;
  truncated: boolean;
} {
  let remainingIssues = allRemaining.map(toRemainingIssue);
  let omittedIssueCount = 0;
  let nextStep: string | undefined;

  if (remainingIssues.length > MAX_REMAINING_ISSUES) {
    omittedIssueCount = remainingIssues.length - MAX_REMAINING_ISSUES;
    remainingIssues = remainingIssues.slice(0, MAX_REMAINING_ISSUES);
    nextStep = "Call check_files on affected paths or get_issue_detail on listed issue IDs.";
  }

  return {
    remainingIssues,
    omittedIssueCount,
    ...(nextStep !== undefined ? { nextStep } : {}),
    truncated: omittedIssueCount > 0,
  };
}

function determineStatus(
  engines: EngineStatuses,
  issueCount: number,
): { status: "clean" | "issues_found" | "error"; code?: string; message?: string } {
  const engineEntries = Object.entries(engines) as [IssueEngine, EngineStatus | undefined][];
  const failedEngines = engineEntries
    .filter(([, s]) => s?.status === "error")
    .map(([e]) => e);

  if (failedEngines.length > 0) {
    return {
      status: "error",
      code: "engine_failed",
      message: `Engine check failed: ${failedEngines.join(", ")}`,
    };
  }

  const hasOkEngine = engineEntries.some(([, s]) => s?.status === "ok");
  if (!hasOkEngine) {
    return {
      status: "error",
      code: "nothing_checked",
      message: "No paths were checked; nothing can be reported clean.",
    };
  }

  return issueCount === 0 ? { status: "clean" } : { status: "issues_found" };
}

function trimEngines(engines: EngineStatuses): EngineStatuses {
  const trimmed: EngineStatuses = {};
  for (const [key, status] of Object.entries(engines) as [IssueEngine, EngineStatus | undefined][]) {
    if (status !== undefined && (status.status !== "disabled" || status.message !== undefined)) {
      trimmed[key] = status;
    }
  }
  return Object.keys(trimmed).length > 0 ? trimmed : engines;
}

function groupByRule(
  issues: readonly NormalizedIssue[],
): Map<string, NormalizedIssue[]> {
  const groups = new Map<string, NormalizedIssue[]>();
  for (const issue of issues) {
    const group = groups.get(issue.rule) ?? [];
    group.push(issue);
    groups.set(issue.rule, group);
  }
  return groups;
}

function toRemainingIssue(issue: NormalizedIssue): RemainingIssue {
  return {
    issueId: issue.issueId,
    file: issue.file,
    line: issue.line,
    col: issue.col,
    rule: issue.rule,
    severity: issue.severity,
    fixable: issue.fixable,
  };
}

function compareRemainingIssues(left: NormalizedIssue, right: NormalizedIssue): number {
  const leftPriority = scorePriority([left], false);
  const rightPriority = scorePriority([right], false);
  return (
    leftPriority - rightPriority ||
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.col - right.col ||
    left.issueId.localeCompare(right.issueId)
  );
}

function createCluster(pending: PendingCluster, clusterId: string): Cluster {
  const issueCount = pending.issues.length;
  const fileCount = countFiles(pending.issues);
  const cluster: Cluster = {
    clusterId,
    rootCauseSummary: createRootCauseSummary(issueCount, pending.rule, fileCount),
    ruleIds: [pending.rule],
    issueCount,
    fileCount,
    priority: pending.priority,
  };
  const suggestedAction = createSuggestedAction(pending, fileCount);
  if (suggestedAction !== undefined) {
    cluster.suggestedAction = suggestedAction;
  }
  if (issueCount > 2) {
    cluster.sampleIssueIds = takeDistinctIssueIds(pending.issues, 2);
  }
  return cluster;
}

function createRootCauseSummary(
  issueCount: number,
  rule: string,
  fileCount: number,
): string {
  const issueNoun = issueCount === 1 ? "issue" : "issues";
  const fileNoun = fileCount === 1 ? "file" : "files";
  return `${String(issueCount)} ${rule} ${issueNoun} across ${String(fileCount)} ${fileNoun}`;
}

function takeDistinctIssueIds(
  issues: readonly NormalizedIssue[],
  limit: number,
): string[] {
  return [...new Set(issues.map((issue) => issue.issueId))].slice(0, limit);
}

function scorePriority(
  issues: readonly NormalizedIssue[],
  systemic: boolean,
): number {
  const hasError = issues.some((issue) => issue.severity === "error");
  const isFixable = issues.length > 0 && issues.every((issue) => issue.fixable);

  if (hasError) {
    if (systemic) {
      return 1;
    }
    if (!isFixable) {
      return 2;
    }
    return 3;
  }

  if (systemic || isFixable) {
    return 5;
  }
  return 4;
}

function computeCheckId(rawIssues: readonly NormalizedIssue[]): string {
  const content = rawIssues
    .map((i) => `${i.engine}:${i.file}:${i.line}:${i.col}:${i.rule}:${i.severity}:${i.message}`)
    .sort()
    .join("\n");
  return createHash("sha1").update(content).digest("hex").slice(0, 8);
}

function createSuggestedAction(pending: PendingCluster, fileCount: number): string | undefined {
  if (pending.issues.every((issue) => issue.fixable)) {
    return pending.systemic
      ? `Apply structured fixes for ${pending.rule} across ${String(fileCount)} files`
      : `Apply the structured fix for ${pending.rule} in ${pending.issues[0]?.file ?? "file"}`;
  }
  return undefined;
}

function comparePendingClusters(left: PendingCluster, right: PendingCluster): number {
  return (
    left.priority - right.priority ||
    right.issues.length - left.issues.length ||
    left.rule.localeCompare(right.rule) ||
    compareIssues(left.issues[0], right.issues[0])
  );
}

function countFiles(issues: readonly NormalizedIssue[]): number {
  return new Set(issues.map((issue) => issue.file)).size;
}
