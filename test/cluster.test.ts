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
    expect(result.response.clusters.map((cluster) => cluster.priority)).toEqual([1, 2, 5, 5]);
    expect(result.issues.every((issue) => issue.clusterId !== undefined)).toBe(true);
    expect(result.response.clusters.every((cluster) => cluster.issueCount === 10)).toBe(true);
    expect(isCheckResponse(result.response)).toBe(true);
  });

  it("keeps small rule groups as individual clusters", () => {
    const issues = [
      makeIssue("issue-a", "src/a.ts", "single-rule", "error", false),
      makeIssue("issue-b", "src/b.ts", "single-rule", "warning", false),
      makeIssue("issue-c", "src/c.ts", "single-rule", "warning", true),
    ];

    const result = clusterIssues(issues);

    expect(result.response.clusters).toHaveLength(3);
    expect(new Set(result.issues.map((issue) => issue.clusterId)).size).toBe(3);
    expect(result.response.clusters.map((cluster) => cluster.priority)).toEqual([1, 2, 4]);
  });

  it("meets the 40-issue compactness acceptance criterion", async () => {
    const rawIssues = await readIssueFixture();
    const result = clusterIssues(rawIssues);
    const rawBytes = Buffer.byteLength(JSON.stringify(rawIssues));
    const clusteredBytes = Buffer.byteLength(JSON.stringify(result.response));
    const reduction = 1 - clusteredBytes / rawBytes;

    expect(result.response.clusters.length).toBeLessThanOrEqual(10);
    expect(reduction).toBeGreaterThanOrEqual(0.7);
    console.info(
      `Phase 3 compactness: raw=${String(rawBytes)} bytes; ` +
        `clustered=${String(clusteredBytes)} bytes; ` +
        `reduction=${(reduction * 100).toFixed(2)}%; ` +
        `clusters=${String(result.response.clusters.length)}`,
    );
  });

  it("truncates responses after ten clusters while assigning every issue", () => {
    const issues = Array.from({ length: 12 }, (_, index) =>
      makeIssue(
        `issue-${String(index)}`,
        `src/file-${String(index)}.ts`,
        `rule-${String(index)}`,
        "warning",
        false,
      ),
    );

    const result = clusterIssues(issues);

    expect(result.response.clusters).toHaveLength(10);
    expect(result.response.truncated).toBe(true);
    expect(result.issues.every((issue) => issue.clusterId !== undefined)).toBe(true);
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
