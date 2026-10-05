import { createHash } from "node:crypto";

import type {
  CheckResponse,
  Cluster,
  EngineStatus,
  EngineStatuses,
  IssueEngine,
  NormalizedIssue,
} from "../schema.js";
import { createSuccessfulEngineStatuses } from "../schema.js";

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

/** Clusters raw issues with the Section 10 heuristic and assigns every issue a clusterId. */
export function clusterIssues(
  rawIssues: readonly NormalizedIssue[],
  maxClusters: number = 10,
  engines: EngineStatuses = createSuccessfulEngineStatuses(),
  projectRoot: string = process.cwd(),
): ClusterResult {
  if (!Number.isInteger(maxClusters) || maxClusters < 1) {
    throw new Error("maxClusters must be a positive integer.");
  }

  const pendingClusters = createPendingClusters(rawIssues).sort(comparePendingClusters);
  const collisionCounts = new Map<string, number>();
  const issueClusterIds = new Map<string, string>();

  const allClusters = pendingClusters.map((pending) => {
    const severity = pending.issues.some((issue) => issue.severity === "error") ? "error" : "warning";
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
  });

  const issues = rawIssues.map((issue) => ({
    ...issue,
    clusterId: requireClusterId(issueClusterIds.get(issue.issueId)),
  }));

  const engineEntries = Object.entries(engines) as [IssueEngine, EngineStatus][];
  const failedEngines = engineEntries
    .filter(([_, s]) => s.status === "error")
    .map(([e]) => e);

  let status: "clean" | "issues_found" | "error";
  let code: string | undefined;
  let message: string | undefined;

  if (failedEngines.length > 0) {
    status = "error";
    code = "engine_failed";
    message = `Engine check failed: ${failedEngines.join(", ")}`;
  } else {
    const hasOkEngine = engineEntries.some(([_, s]) => s.status === "ok");
    if (!hasOkEngine) {
      status = "error";
      code = "nothing_checked";
      message = "No paths were checked; nothing can be reported clean.";
    } else if (rawIssues.length === 0) {
      status = "clean";
    } else {
      status = "issues_found";
    }
  }

  return {
    issues,
    response: {
      schemaVersion: "1.3",
      status,
      projectRoot,
      engines,
      totalIssues: rawIssues.length,
      clusters: allClusters.slice(0, maxClusters),
      truncated: allClusters.length > maxClusters,
      loopWarning: null,
      fileRuleChurnWarning: null,
      checkId: computeCheckId(rawIssues),
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message } : {}),
    },
  };
}

function createPendingClusters(
  rawIssues: readonly NormalizedIssue[],
): PendingCluster[] {
  const groups = groupByRule(rawIssues);
  const clusters: PendingCluster[] = [];
  for (const rule of [...groups.keys()].sort()) {
    const issues = [...(groups.get(rule) ?? [])].sort(compareIssues);
    const systemic = issues.length > 3 && countFiles(issues) > 2;
    if (systemic) {
      clusters.push({ issues, priority: scorePriority(issues, true), rule, systemic: true });
    } else {
      for (const issue of issues) {
        clusters.push({
          issues: [issue],
          priority: scorePriority([issue], false),
          rule,
          systemic: false,
        });
      }
    }
  }
  return clusters;
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

function createCluster(pending: PendingCluster, clusterId: string): Cluster {
  const issueCount = pending.issues.length;
  const fileCount = countFiles(pending.issues);
  return {
    clusterId,
    rootCauseSummary: createRootCauseSummary(issueCount, pending.rule, fileCount),
    ruleIds: [pending.rule],
    issueCount,
    fileCount,
    priority: pending.priority,
    suggestedAction: createSuggestedAction(pending, fileCount),
    sampleIssueIds: takeDistinctIssueIds(pending.issues, 2),
  };
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

function createSuggestedAction(pending: PendingCluster, fileCount: number): string {
  if (pending.systemic && pending.issues.every((issue) => issue.fixable)) {
    return `Apply structured fixes for ${pending.rule} across ${String(fileCount)} files`;
  }
  if (pending.systemic) {
    return `Review the shared cause of ${pending.rule} across ${String(fileCount)} files`;
  }
  const issue = pending.issues[0];
  if (issue === undefined) {
    throw new Error("Cannot suggest an action for an empty cluster.");
  }
  return issue.fixable
    ? `Apply the structured fix for ${pending.rule} in ${issue.file}`
    : `Review ${pending.rule} in ${issue.file} at line ${String(issue.line)}`;
}

function comparePendingClusters(left: PendingCluster, right: PendingCluster): number {
  return (
    left.priority - right.priority ||
    right.issues.length - left.issues.length ||
    left.rule.localeCompare(right.rule) ||
    compareIssues(left.issues[0], right.issues[0])
  );
}

function compareIssues(
  left: NormalizedIssue | undefined,
  right: NormalizedIssue | undefined,
): number {
  if (left === undefined || right === undefined) {
    return left === right ? 0 : left === undefined ? 1 : -1;
  }
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.col - right.col ||
    left.issueId.localeCompare(right.issueId)
  );
}

function countFiles(issues: readonly NormalizedIssue[]): number {
  return new Set(issues.map((issue) => issue.file)).size;
}

function requireClusterId(clusterId: string | undefined): string {
  if (clusterId === undefined) {
    throw new Error("Every issue must be assigned to a cluster.");
  }
  return clusterId;
}
