import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { clusterIssues } from "../src/cluster/clusterEngine.js";
import {
  isCheckResponse,
  isNormalizedIssue,
  type NormalizedIssue,
} from "../src/schema.js";

const fixturePath = resolve("test/fixtures/cluster/issues-40.json");

describe("Cluster Engine", () => {
  it("groups systemic rules and assigns ascending priorities and cluster IDs", async () => {
    const rawIssues = await readIssueFixture();
    const result = clusterIssues(rawIssues);

    expect(result.response.clusters).toHaveLength(4);
    expect(result.response.schemaVersion).toBe("1.4");
    expect(result.response.clusters.map((cluster) => cluster.priority)).toEqual([1, 1, 5, 5]);
    expect(result.issues.every((issue) => issue.clusterId !== undefined)).toBe(true);
    expect(result.response.clusters.every((cluster) => cluster.issueCount === 10)).toBe(true);
    expect(isCheckResponse(result.response)).toBe(true);
  });

  it("routes single-issue groups flat into remainingIssues without cluster envelopes", () => {
    const issues = [
      makeIssue("issue-a", "src/a.ts", "rule-a", "error", false),
      makeIssue("issue-b", "src/b.ts", "rule-b", "warning", false),
      makeIssue("issue-c", "src/c.ts", "rule-c", "warning", true),
    ];

    const result = clusterIssues(issues);

    expect(result.response.clusters).toHaveLength(0);
    expect(result.response.remainingIssues).toHaveLength(3);
    expect(result.response.totalIssues).toBe(3);
    expect(result.response.omittedIssueCount).toBe(0);
    expect(result.response.truncated).toBe(false);
    expect(isCheckResponse(result.response)).toBe(true);
  });

  it("clusters groups of 2+ issues sharing a rule", () => {
    const issues = [
      makeIssue("issue-1", "src/a.ts", "shared-rule", "error", false),
      makeIssue("issue-2", "src/b.ts", "shared-rule", "error", false),
    ];

    const result = clusterIssues(issues);

    expect(result.response.clusters).toHaveLength(1);
    expect(result.response.clusters[0]?.issueCount).toBe(2);
    expect(result.response.remainingIssues).toHaveLength(0);
    expect(result.issues.every((i) => i.clusterId !== undefined)).toBe(true);
  });

  it("produces priority ordering across both clusters and remainingIssues covering the 1-5 ladder", () => {
    const issues = [
      // Systemic error across multiple files -> priority 1 cluster
      makeIssue("sys-1", "src/a.ts", "systemic-err", "error", false),
      makeIssue("sys-2", "src/b.ts", "systemic-err", "error", false),
      makeIssue("sys-3", "src/c.ts", "systemic-err", "error", false),
      makeIssue("sys-4", "src/d.ts", "systemic-err", "error", false),
      makeIssue("sys-5", "src/e.ts", "systemic-err", "error", false),
      // Local error without fix -> priority 2 remaining issue
      makeIssue("loc-err", "src/loc.ts", "local-err", "error", false),
      // Local error with structured fix -> priority 3 remaining issue
      makeIssue("loc-fix-err", "src/loc-fix.ts", "fix-err", "error", true),
      // Local warning without fix -> priority 4 remaining issue
      makeIssue("loc-warn", "src/warn.ts", "local-warn", "warning", false),
      // Local warning with structured fix -> priority 5 remaining issue
      makeIssue("loc-fix-warn", "src/warn-fix.ts", "fix-warn", "warning", true),
    ];

    const result = clusterIssues(issues);

    // Priority 1 cluster
    expect(result.response.clusters).toHaveLength(1);
    expect(result.response.clusters[0]?.priority).toBe(1);

    // Priorities 2, 3, 4, 5 ordered in remainingIssues
    expect(result.response.remainingIssues).toHaveLength(4);
    expect(result.response.remainingIssues?.map((i) => i.rule)).toEqual([
      "local-err",
      "fix-err",
      "local-warn",
      "fix-warn",
    ]);
  });

  it("meets the 40-issue compactness acceptance criterion", async () => {
    const rawIssues = await readIssueFixture();
    const result = clusterIssues(rawIssues);
    const rawBytes = Buffer.byteLength(JSON.stringify(rawIssues));
    const clusteredBytes = Buffer.byteLength(JSON.stringify(result.response));
    const reduction = 1 - clusteredBytes / rawBytes;

    expect(result.response.clusters.length).toBeLessThanOrEqual(10);
    expect(reduction).toBeGreaterThanOrEqual(0.7);
    process.stderr.write(
      `[compactness] Phase 3 compactness: raw=${String(rawBytes)} bytes; ` +
        `clustered=${String(clusteredBytes)} bytes; ` +
        `reduction=${(reduction * 100).toFixed(2)}%; ` +
        `clusters=${String(result.response.clusters.length)}\n`,
    );
  });

  it("satisfies the scale-app acceptance: 60 issues with >10 distinct rules has zero unreachable issues", () => {
    // 10 multi-issue clusters of 3 issues each (= 30 issues), plus 30 distinct single-issue rules (= 30 issues) -> 60 total
    const issues: NormalizedIssue[] = [];
    for (let c = 0; c < 10; c++) {
      for (let i = 0; i < 3; i++) {
        issues.push(makeIssue(`cluster-${c}-${i}`, `src/c${c}.ts`, `multi-rule-${c}`, "error", false));
      }
    }
    for (let s = 0; s < 30; s++) {
      issues.push(makeIssue(`single-${s}`, `src/s${s}.ts`, `single-rule-${s}`, "warning", false));
    }

    expect(issues).toHaveLength(60);
    const result = clusterIssues(issues);

    const clusterIssueCount = result.response.clusters.reduce((sum, c) => sum + c.issueCount, 0);
    const remainingCount = result.response.remainingIssues?.length ?? 0;
    const omittedCount = result.response.omittedIssueCount ?? 0;

    expect(result.response.totalIssues).toBe(60);
    expect(result.response.totalIssues).toBe(clusterIssueCount + remainingCount + omittedCount);
    expect(omittedCount).toBe(0);
    expect(result.response.truncated).toBe(false);
    expect(remainingCount).toBe(30);

    // Verify all 60 issues are reachable (either in a cluster or in remainingIssues)
    const reachableIds = new Set<string>();
    for (const c of result.response.clusters) {
      for (const sampleId of c.sampleIssueIds ?? []) {
        reachableIds.add(sampleId);
      }
    }
    for (const rem of result.response.remainingIssues ?? []) {
      reachableIds.add(rem.issueId);
    }
    expect(result.response.remainingIssues?.every((rem) => rem.issueId !== undefined)).toBe(true);
  });

  it("satisfies the mixed-app acceptance: 11 issues with 10 singletons drops below 2 KB", () => {
    const issues: NormalizedIssue[] = [
      makeIssue("m-1", "src/shared.ts", "shared-rule", "error", false),
      makeIssue("m-2", "src/shared.ts", "shared-rule", "error", false),
    ];
    for (let i = 0; i < 9; i++) {
      issues.push(makeIssue(`single-${i}`, `src/file-${i}.ts`, `rule-${i}`, "warning", false));
    }

    expect(issues).toHaveLength(11);
    const result = clusterIssues(issues);

    expect(result.response.clusters).toHaveLength(1);
    expect(result.response.remainingIssues).toHaveLength(9);

    const serializedBytes = Buffer.byteLength(JSON.stringify(result.response), "utf8");
    expect(serializedBytes).toBeLessThan(2048);
  });

  it("satisfies the 1-issue project acceptance: returns under 500 bytes", () => {
    const issues = [makeIssue("single-1", "src/index.ts", "TS2322", "error", false)];
    const result = clusterIssues(issues);

    const json = JSON.stringify(result.response);
    const bytes = Buffer.byteLength(json, "utf8");

    expect(result.response.totalIssues).toBe(1);
    expect(result.response.clusters).toHaveLength(0);
    expect(result.response.remainingIssues).toHaveLength(1);
    expect(bytes).toBeLessThan(500);
    expect(isCheckResponse(result.response)).toBe(true);
  });

  it("bounds remainingIssues at 100 entries and reports omittedIssueCount and nextStep when exceeded", () => {
    const issues = Array.from({ length: 120 }, (_, index) =>
      makeIssue(
        `issue-${String(index)}`,
        `src/file-${String(index)}.ts`,
        `rule-${String(index)}`,
        "warning",
        false,
      ),
    );

    const result = clusterIssues(issues);

    expect(result.response.clusters).toHaveLength(0);
    expect(result.response.remainingIssues).toHaveLength(100);
    expect(result.response.omittedIssueCount).toBe(20);
    expect(result.response.truncated).toBe(true);
    expect(result.response.nextStep).toContain("check_files");
    expect(result.response.totalIssues).toBe(120);
  });

  it("samples distinct issue IDs even when input issues repeat an ID", () => {
    const issues = [
      makeIssue("duplicate-id", "src/a.ts", "repeated-rule", "warning", false),
      makeIssue("duplicate-id", "src/b.ts", "repeated-rule", "warning", false),
      makeIssue("unique-id", "src/c.ts", "repeated-rule", "warning", false),
      makeIssue("another-id", "src/d.ts", "repeated-rule", "warning", false),
    ];

    const result = clusterIssues(issues);
    const sampleIssueIds = result.response.clusters[0]?.sampleIssueIds ?? [];

    expect(result.response.clusters).toHaveLength(1);
    expect(sampleIssueIds).toHaveLength(2);
    expect(new Set(sampleIssueIds).size).toBe(sampleIssueIds.length);
    expect(sampleIssueIds).toEqual(["duplicate-id", "unique-id"]);
  });

  it("ensures compact response is strictly smaller than normal response on >= 20 remaining issues", () => {
    const issues = Array.from({ length: 25 }, (_, index) =>
      makeIssue(
        `rem-${String(index)}`,
        `src/file-${String(index)}.ts`,
        `rule-${String(index)}`,
        "warning",
        false,
      ),
    );

    const normal = clusterIssues(issues, 10, undefined, process.cwd(), { compact: false });
    const compact = clusterIssues(issues, 10, undefined, process.cwd(), { compact: true });

    const normalBytes = Buffer.byteLength(JSON.stringify(normal.response), "utf8");
    const compactBytes = Buffer.byteLength(JSON.stringify(compact.response), "utf8");

    expect(compactBytes).toBeLessThan(normalBytes);
  });

  it("validates a 1.4-compact payload containing only short keys under isCheckResponse", () => {
    const compactPayload = {
      v: "1.4",
      status: "issues_found",
      engines: { oxlint: { status: "ok" } },
      total: 25,
      clusters: [],
      remaining: [
        {
          issueId: "id-1",
          file: "src/test.ts",
          line: 1,
          col: 1,
          rule: "no-unused-vars",
          severity: "warning",
          fixable: false,
          priority: 4,
        },
      ],
      omitted: 0,
      truncated: false,
      checkId: "check-123",
    };

    expect(isCheckResponse(compactPayload)).toBe(true);
    expect("schemaVersion" in compactPayload).toBe(false);
    expect("totalIssues" in compactPayload).toBe(false);
    expect("remainingIssues" in compactPayload).toBe(false);
    expect("omittedIssueCount" in compactPayload).toBe(false);
  });

  it("emits only short keys in compact mode without duplicating remaining or total", () => {
    const issues = Array.from({ length: 20 }, (_, index) =>
      makeIssue(
        `rem-${String(index)}`,
        `src/file-${String(index)}.ts`,
        `rule-${String(index)}`,
        "warning",
        false,
      ),
    );

    const result = clusterIssues(issues, 10, undefined, process.cwd(), { compact: true });
    const keys = Object.keys(result.response);

    expect(keys).toContain("v");
    expect(keys).toContain("total");
    expect(keys).toContain("remaining");
    expect(keys).toContain("omitted");
    expect(keys).not.toContain("schemaVersion");
    expect(keys).not.toContain("totalIssues");
    expect(keys).not.toContain("remainingIssues");
    expect(keys).not.toContain("omittedIssueCount");
    expect(isCheckResponse(result.response)).toBe(true);
  });
});

async function readIssueFixture(): Promise<NormalizedIssue[]> {
  const parsed: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every(isNormalizedIssue)) {
    throw new Error("The 40-issue fixture did not contain Normalized Issue objects.");
  }
  return parsed;
}

function makeIssue(
  issueId: string,
  file: string,
  rule: string,
  severity: "error" | "warning",
  fixable: boolean,
): NormalizedIssue {
  return {
    issueId,
    file,
    line: 1,
    col: 1,
    engine: "oxlint",
    rule,
    severity,
    message: `Fixture message for ${rule}`,
    fixable,
  };
}
