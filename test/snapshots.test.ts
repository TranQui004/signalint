import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { SnapshotStore, type DiagnosticSnapshot } from "../src/diagnostics/snapshots.js";
import { createServer } from "../src/server/createServer.js";
import type { Cluster, NormalizedIssue } from "../src/schema.js";

const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(servers.map((s) => s.close()));
  clients.length = 0;
  servers.length = 0;
});

function makeMockIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    issueId: "test-issue-1",
    file: "src/sample.ts",
    line: 10,
    col: 1,
    engine: "oxlint",
    rule: "no-unused-vars",
    severity: "error",
    message: "Variable 'x' is defined but never used.",
    fixable: false,
    ...overrides,
  };
}

function makeMockSnapshot(checkId: string, issues: NormalizedIssue[] = []): DiagnosticSnapshot {
  return {
    checkId,
    projectRoot: process.cwd(),
    timestamp: Date.now(),
    status: issues.length > 0 ? "issues_found" : "clean",
    issues,
    clusters: [],
    remainingIssues: issues.map((i) => ({
      issueId: i.issueId,
      file: i.file,
      line: i.line,
      col: i.col,
      rule: i.rule,
      severity: i.severity,
      fixable: i.fixable,
    })),
    totalIssues: issues.length,
    omittedIssueCount: 0,
    engines: { oxlint: { status: "ok" } },
    source: "files",
    durationMs: 12,
  };
}

describe("SnapshotStore unit tests", () => {
  it("stores and retrieves snapshots by checkId", () => {
    const store = new SnapshotStore({ maxSnapshots: 10 });
    const issue = makeMockIssue();
    const snapshot = makeMockSnapshot("check-001", [issue]);

    store.saveSnapshot(snapshot);

    const retrieved = store.getSnapshot("check-001");
    expect(retrieved).toBeDefined();
    expect(retrieved?.checkId).toBe("check-001");
    expect(retrieved?.issues).toHaveLength(1);
    expect(retrieved?.issues[0]?.issueId).toBe("test-issue-1");
  });

  it("enforces bounded capacity eviction for oldest snapshots", () => {
    const store = new SnapshotStore({ maxSnapshots: 3 });
    store.saveSnapshot(makeMockSnapshot("check-1"));
    store.saveSnapshot(makeMockSnapshot("check-2"));
    store.saveSnapshot(makeMockSnapshot("check-3"));
    expect(store.size()).toBe(3);

    // Adding 4th should evict check-1
    store.saveSnapshot(makeMockSnapshot("check-4"));
    expect(store.size()).toBe(3);
    expect(store.getSnapshot("check-1")).toBeUndefined();
    expect(store.isExpired("check-1")).toBe(true);
    expect(store.getSnapshot("check-2")).toBeDefined();
    expect(store.getSnapshot("check-4")).toBeDefined();
  });

  it("handles TTL expiration properly", async () => {
    const store = new SnapshotStore({ ttlMs: 10 });
    const snapshot = makeMockSnapshot("check-fast-expire");
    snapshot.timestamp = Date.now() - 20; // 20ms ago

    store.saveSnapshot(snapshot);
    expect(store.getSnapshot("check-fast-expire")).toBeUndefined();
    expect(store.isExpired("check-fast-expire")).toBe(true);
  });

  it("resolves issue details with explicit checkId and returns deterministic stale codes", () => {
    const store = new SnapshotStore({ maxSnapshots: 10 });
    const issueA = makeMockIssue({ issueId: "id-a", clusterId: "cluster-1" });
    store.saveSnapshot(makeMockSnapshot("check-a", [issueA]));

    const result = store.resolveIssues({ clusterId: "cluster-1", checkId: "check-a" });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);

    const unknownResult = store.resolveIssues({ clusterId: "cluster-1", checkId: "nonexistent-check" });
    expect(unknownResult).toEqual({
      status: "stale",
      code: "unknown_check_id",
      message: "Check ID 'nonexistent-check' is unknown; run check_project again.",
    });
  });

  it("enforces deep immutability by preventing mutations to returned snapshots from affecting the store", () => {
    const store = new SnapshotStore({ maxSnapshots: 10 });
    const issue = makeMockIssue({ issueId: "immutable-1", file: "src/immutable.ts" });
    const snapshot = makeMockSnapshot("check-immutable", [issue]);
    snapshot.clusters = [
      {
        clusterId: "c1",
        rootCauseSummary: "Summary",
        ruleIds: ["rule-1"],
        issueCount: 1,
        fileCount: 1,
        priority: 1,
      },
    ];

    store.saveSnapshot(snapshot);

    const retrieved1 = store.getSnapshot("check-immutable");
    expect(retrieved1).toBeDefined();
    expect(retrieved1?.issues).toHaveLength(1);
    expect(retrieved1?.clusters).toHaveLength(1);

    // Mutate the retrieved snapshot copy
    (retrieved1!.issues as NormalizedIssue[]).push(
      makeMockIssue({ issueId: "injected-issue", file: "src/injected.ts" }),
    );
    (retrieved1!.clusters as Cluster[]).push({
      clusterId: "c2",
      rootCauseSummary: "Injected",
      ruleIds: ["rule-2"],
      issueCount: 1,
      fileCount: 1,
      priority: 2,
    });

    // Retrieve again from store and assert internal store remains unmodified
    const retrieved2 = store.getSnapshot("check-immutable");
    expect(retrieved2).toBeDefined();
    expect(retrieved2?.issues).toHaveLength(1);
    expect(retrieved2?.issues[0]?.issueId).toBe("immutable-1");
    expect(retrieved2?.clusters).toHaveLength(1);
    expect(retrieved2?.clusters[0]?.clusterId).toBe("c1");
  });
});

describe("Concurrent Client Isolation", () => {
  it("isolates diagnostic snapshots and issue details between concurrent clients without crosstalk", async () => {
    const store = new SnapshotStore({ projectRoot: process.cwd() });
    const provider = (paths: readonly string[]) => {
      if (paths.includes("package.json")) {
        return Promise.resolve({
          issues: [makeMockIssue({ issueId: "issue-A-1", file: "package.json" })],
          cache: { hits: 1, misses: 0 },
          engines: { oxlint: { status: "ok" as const } },
        });
      }
      return Promise.resolve({
        issues: [makeMockIssue({ issueId: "issue-B-1", file: "tsconfig.json" })],
        cache: { hits: 0, misses: 1 },
        engines: { oxlint: { status: "ok" as const } },
      });
    };

    const server1 = createServer({
      snapshotStore: store,
      fileIssueProvider: provider,
    });
    const server2 = createServer({
      snapshotStore: store,
      fileIssueProvider: provider,
    });
    servers.push(server1, server2);

    const [c1Transport, s1Transport] = InMemoryTransport.createLinkedPair();
    const [c2Transport, s2Transport] = InMemoryTransport.createLinkedPair();

    await server1.connect(s1Transport);
    await server2.connect(s2Transport);

    const client1 = new Client({ name: "client-1", version: "1.0.0" });
    const client2 = new Client({ name: "client-2", version: "1.0.0" });
    clients.push(client1, client2);

    await client1.connect(c1Transport);
    await client2.connect(c2Transport);

    // Run both checks concurrently
    const [res1, res2] = await Promise.all([
      client1.callTool({ name: "check_files", arguments: { files: ["package.json"] } }),
      client2.callTool({ name: "check_files", arguments: { files: ["tsconfig.json"] } }),
    ]);

    const content1 = parseToolResult(res1) as {
      checkId: string;
      totalIssues: number;
    };
    const content2 = parseToolResult(res2) as {
      checkId: string;
      totalIssues: number;
    };

    expect(content1.checkId).toBeDefined();
    expect(content2.checkId).toBeDefined();
    expect(content1.checkId).not.toEqual(content2.checkId);

    // Client 1 retrieves its issue detail using checkId1
    const detail1 = await client1.callTool({
      name: "get_issue_detail",
      arguments: { issueId: "issue-A-1", checkId: content1.checkId },
    });
    const parsedDetail1 = parseToolResult(detail1) as { issues: NormalizedIssue[] };
    expect(Array.isArray(parsedDetail1.issues)).toBe(true);
    expect(parsedDetail1.issues[0]?.issueId).toBe("issue-A-1");

    // Client 2 retrieves its issue detail using checkId2
    const detail2 = await client2.callTool({
      name: "get_issue_detail",
      arguments: { issueId: "issue-B-1", checkId: content2.checkId },
    });
    const parsedDetail2 = parseToolResult(detail2) as { issues: NormalizedIssue[] };
    expect(Array.isArray(parsedDetail2.issues)).toBe(true);
    expect(parsedDetail2.issues[0]?.issueId).toBe("issue-B-1");

    // Client 1 requests detail using checkId2 but issueId belonging only to A -> returns deterministic stale response
    const crossDetail = await client1.callTool({
      name: "get_issue_detail",
      arguments: { issueId: "issue-A-1", checkId: content2.checkId },
    });
    const parsedCrossDetail = parseToolResult(crossDetail);
    expect(parsedCrossDetail).toEqual({
      status: "stale",
      message: "This cluster/issue no longer exists; run check_project again.",
    });

    // Verify snapshot 1 contains only package.json diagnostics
    const snap1 = await client1.callTool({
      name: "get_diagnostic_snapshot",
      arguments: { checkId: content1.checkId },
    });
    const snapContent1 = parseToolResult(snap1) as Record<string, unknown>;
    expect(snapContent1["checkId"]).toBe(content1.checkId);
    expect(((snapContent1["remainingIssues"] as NormalizedIssue[])[0])?.file).toBe("package.json");

    // Verify snapshot 2 contains only tsconfig.json diagnostics
    const snap2 = await client2.callTool({
      name: "get_diagnostic_snapshot",
      arguments: { checkId: content2.checkId },
    });
    const snapContent2 = parseToolResult(snap2) as Record<string, unknown>;
    expect(snapContent2["checkId"]).toBe(content2.checkId);
    expect(((snapContent2["remainingIssues"] as NormalizedIssue[])[0])?.file).toBe("tsconfig.json");
  });
});

function parseToolResult(result: unknown): unknown {
  if (!isRecord(result)) {
    throw new Error("Expected object tool result");
  }
  const content = result["content"];
  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0]["text"] !== "string") {
    throw new Error("Expected text tool result");
  }
  return JSON.parse(content[0]["text"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
