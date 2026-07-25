import type {
  CheckResponse,
  Cluster,
  NormalizedIssue,
} from "../schema.js";

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
): ClusterResult {
  if (!Number.isInteger(maxClusters) || maxClusters < 1) {
    throw new Error("maxClusters must be a positive integer.");
  }

  const pendingClusters = createPendingClusters(rawIssues).sort(comparePendingClusters);
  const issueClusterIds = new Map<NormalizedIssue, string>();
  const allClusters = pendingClusters.map((pending, index) => {
    const clusterId = `c${String(index + 1)}`;
    for (const issue of pending.issues) {
      issueClusterIds.set(issue, clusterId);
    }
    return createCluster(pending, clusterId);
  });
  const issues = rawIssues.map((issue) => ({
    ...issue,
    clusterId: requireClusterId(issueClusterIds.get(issue)),
  }));

  return {
    issues,
    response: {
      status: rawIssues.length === 0 ? "clean" : "issues_found",
      totalIssues: rawIssues.length,
      clusters: allClusters.slice(0, maxClusters),
      truncated: allClusters.length > maxClusters,
      loopWarning: null,
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
    rootCauseSummary: `${String(issueCount)} ${pending.rule} issues across ${String(fileCount)} files`,
    ruleIds: [pending.rule],
    issueCount,
    fileCount,
    priority: pending.priority,
    suggestedAction: createSuggestedAction(pending, fileCount),
    sampleIssueIds: pending.issues.slice(0, 2).map((issue) => issue.issueId),
  };
}

function scorePriority(
  issues: readonly NormalizedIssue[],
  systemic: boolean,
): number {
  if (issues.some((issue) => issue.severity === "error" && !issue.fixable)) {
    return 1;
  }
  if (issues.some((issue) => !issue.fixable)) {
    return 2;
  }
  if (systemic) {
    return 5;
  }
  return issues.some((issue) => issue.severity === "error") ? 3 : 4;
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
