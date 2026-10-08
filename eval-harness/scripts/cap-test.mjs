// Round 4b: exercises the MAX_REMAINING_ISSUES=100 cap and the 200-issue scale case
// by calling the PR #52 clustering engine directly with fabricated, deterministic issues.
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { encode } from "gpt-tokenizer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = join(root, "results");
mkdirSync(resultsDir, { recursive: true });

const { clusterIssues } = await import(join(root, "builds", "pr52", "dist", "src", "cluster", "clusterEngine.js"));

const mkId = (file, rule, line, message) =>
  createHash("sha256").update(`${file}:${rule}:${line}:${message}`).digest("hex");

function mkIssue(file, rule, line, message, severity = "error") {
  return {
    issueId: mkId(file, rule, line, message),
    file,
    line,
    col: 1,
    rule,
    severity,
    message,
    fixable: false,
    engine: rule.startsWith("TS") ? "tsc" : "oxlint",
  };
}

/**
 * Builds a project-shaped issue set:
 *  - `clusterCount` rules with `clusterSize` issues each (multi-issue clusters)
 *  - `singletonCount` rules with exactly one issue each (flat remaining records)
 */
function fabricate(clusterCount, clusterSize, singletonCount) {
  const issues = [];
  for (let c = 0; c < clusterCount; c += 1) {
    const rule = `TS${2000 + c}`;
    for (let i = 0; i < clusterSize; i += 1) {
      issues.push(mkIssue(`src/cluster${c}/file${i}.ts`, rule, 10, `cluster rule ${c} message`));
    }
  }
  for (let s = 0; s < singletonCount; s += 1) {
    const rule = `no-unique-rule-${s}`;
    issues.push(mkIssue(`src/solo/file${s}.ts`, rule, s + 1, `unique rule ${s} message`));
  }
  return issues;
}

const scenarios = [
  { label: "small (10 clusters x 4, 20 solo)", clusters: 10, size: 4, solo: 20 },
  { label: "at cap (12 x 5, 90 solo)", clusters: 12, size: 5, solo: 90 },
  { label: "just over (12 x 5, 100 solo)", clusters: 12, size: 5, solo: 100 },
  { label: "over (12 x 5, 120 solo)", clusters: 12, size: 5, solo: 120 },
  { label: "big (20 x 10, 200 solo)", clusters: 20, size: 10, solo: 200 },
];

const rows = [];
for (const scenario of scenarios) {
  const issues = fabricate(scenario.clusters, scenario.size, scenario.solo);
  const { response } = clusterIssues(issues, 10);
  const pretty = JSON.stringify(response, null, 2);
  const min = JSON.stringify(response);
  const inClusters = (response.clusters ?? []).reduce((sum, c) => sum + c.issueCount, 0);
  const remaining = (response.remainingIssues ?? response.remaining ?? []).length;
  const omitted = response.omittedIssueCount ?? response.omitted ?? 0;
  rows.push({
    scenario: scenario.label,
    total: response.totalIssues,
    clusters: (response.clusters ?? []).length,
    inClusters,
    remaining,
    omitted,
    invariant: response.totalIssues === inClusters + remaining + omitted,
    truncated: response.truncated,
    nextStep: response.nextStep ? "yes" : "no",
    // Can the agent still reach every issue? clusters expose sampleIssueIds + get_issue_detail,
    // remaining exposes full flat records; `omitted` ones are reachable only via get_issue_detail.
    reachableNow: inClusters + remaining,
    prettyB: Buffer.byteLength(pretty),
    minB: Buffer.byteLength(min),
    tokens: encode(min).length,
  });
}

console.table(rows);
writeFileSync(join(resultsDir, "round4-cap.json"), JSON.stringify(rows, null, 2));
console.log("written:", join(resultsDir, "round4-cap.json"));
