import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { computeDiagnosticDelta } from "../src/diagnostics/delta.js";
import type { DiagnosticSnapshot } from "../src/diagnostics/snapshots.js";
import { createServer } from "../src/server/createServer.js";
import type { NormalizedIssue } from "../src/schema.js";

const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(servers.map((s) => s.close()));
  clients.length = 0;
  servers.length = 0;
});

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    issueId: "sample-issue-id",
    file: "src/sample.ts",
    line: 10,
    col: 5,
    engine: "oxlint",
    rule: "no-unused-vars",
    severity: "error",
    message: "Variable 'x' is defined but never used.",
    fixable: false,
    ...overrides,
  };
}

function makeSnapshot(checkId: string, issues: NormalizedIssue[]): DiagnosticSnapshot {
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
    durationMs: 15,
  };
}

describe("Diagnostic Delta Computation", () => {
  it("recognizes line shifts as unchanged issues rather than false additions/removals", () => {
    // Baseline issue at line 10
    const baselineIssue = makeIssue({
      issueId: "hash-line-10",
      line: 10,
      message: "Variable 'x' is defined but never used.",
    });
    // Current issue shifted to line 18 after adding lines
    const currentShiftedIssue = makeIssue({
      issueId: "hash-line-18",
      line: 18,
      message: "Variable 'x' is defined but never used.",
    });

    const baseline = makeSnapshot("base-1", [baselineIssue]);
    const current = makeSnapshot("curr-1", [currentShiftedIssue]);

    const delta = computeDiagnosticDelta(baseline, current);

    expect(delta.errorsIntroduced).toBe(0);
    expect(delta.errorsResolved).toBe(0);
    expect(delta.netDelta).toBe(0);
    expect(delta.unchangedIssues).toHaveLength(1);
    expect(delta.introducedIssues).toHaveLength(0);
    expect(delta.resolvedIssues).toHaveLength(0);
  });

  it("accurately computes introduced, resolved, and net error deltas", () => {
    const issueResolved = makeIssue({ issueId: "res-1", rule: "rule-1", line: 5 });
    const issuePersistent = makeIssue({ issueId: "stay-1", rule: "rule-2", line: 20 });
    const issueIntroduced = makeIssue({ issueId: "new-1", rule: "rule-3", line: 35 });

    const baseline = makeSnapshot("base-2", [issueResolved, issuePersistent]);
    const current = makeSnapshot("curr-2", [issuePersistent, issueIntroduced]);

    const delta = computeDiagnosticDelta(baseline, current);

    expect(delta.errorsIntroduced).toBe(1);
    expect(delta.errorsResolved).toBe(1);
    expect(delta.netDelta).toBe(0);
    expect(delta.introducedIssues).toHaveLength(1);
    expect(delta.introducedIssues[0]?.issueId).toBe("new-1");
    expect(delta.resolvedIssues).toHaveLength(1);
    expect(delta.resolvedIssues[0]?.issueId).toBe("res-1");
    expect(delta.unchangedIssues).toHaveLength(1);
    expect(delta.unchangedIssues[0]?.issueId).toBe("stay-1");
  });

  it("generates an actionable nextStep summary when new errors are introduced", () => {
    const baseline = makeSnapshot("base-3", []);
    const current = makeSnapshot("curr-3", [makeIssue({ issueId: "err-1" })]);

    const delta = computeDiagnosticDelta(baseline, current);

    expect(delta.errorsIntroduced).toBe(1);
    expect(delta.nextStep).toContain("1 new error(s) introduced");
  });
});

describe("compare_diagnostics and after_edit_check MCP tools", () => {
  it("compares two existing snapshots via compare_diagnostics", async () => {
    let checkCounter = 0;
    const server = createServer({
      fileIssueProvider: () => {
        checkCounter++;
        if (checkCounter === 1) {
          return Promise.resolve({
            issues: [makeIssue({ issueId: "old-issue" })],
            cache: { hits: 0, misses: 1 },
            engines: { oxlint: { status: "ok" } },
          });
        }
        return Promise.resolve({
          issues: [],
          cache: { hits: 1, misses: 0 },
          engines: { oxlint: { status: "ok" } },
        });
      },
    });
    servers.push(server);

    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "delta-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    // Run first check (baseline)
    const res1 = await client.callTool({ name: "check_files", arguments: { files: ["package.json"] } });
    const content1 = parseToolResult(res1) as { checkId: string };

    // Run second check (current, resolved)
    const res2 = await client.callTool({ name: "check_files", arguments: { files: ["package.json"] } });
    const content2 = parseToolResult(res2) as { checkId: string };

    const compareRes = await client.callTool({
      name: "compare_diagnostics",
      arguments: { baselineCheckId: content1.checkId, currentCheckId: content2.checkId },
    });
    const compareData = parseToolResult(compareRes) as Record<string, unknown>;

    expect(compareData["status"]).toBe("ok");
    expect(compareData["errorsIntroduced"]).toBe(0);
    expect(compareData["errorsResolved"]).toBe(1);
    expect(compareData["netDelta"]).toBe(-1);
    expect(compareData["nextStep"]).toContain("All baseline errors resolved");
  });

  it("returns stale error with unknown_check_id when compare_diagnostics receives non-existent id", async () => {
    const server = createServer();
    servers.push(server);
    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "delta-stale-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    const compareRes = await client.callTool({
      name: "compare_diagnostics",
      arguments: { baselineCheckId: "missing-1", currentCheckId: "missing-2" },
    });
    const compareData = parseToolResult(compareRes) as Record<string, unknown>;

    expect(compareData["status"]).toBe("stale");
    expect(compareData["code"]).toBe("unknown_check_id");
  });

  it("runs incremental check and returns inline delta with after_edit_check", async () => {
    let calls = 0;
    const server = createServer({
      fileIssueProvider: () => {
        calls++;
        if (calls === 1) {
          return Promise.resolve({
            issues: [makeIssue({ issueId: "bug-1" })],
            cache: { hits: 0, misses: 1 },
            engines: { oxlint: { status: "ok" as const } },
          });
        }
        return Promise.resolve({
          issues: [],
          cache: { hits: 1, misses: 0 },
          engines: { oxlint: { status: "ok" as const } },
        });
      },
    });
    servers.push(server);
    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "edit-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    // Initial check
    const baseCheck = await client.callTool({ name: "check_files", arguments: { files: ["package.json"] } });
    const baseData = parseToolResult(baseCheck) as { checkId: string };

    // After edit check referencing baseline
    const editCheck = await client.callTool({
      name: "after_edit_check",
      arguments: { files: ["package.json"], baselineCheckId: baseData.checkId },
    });
    const editData = parseToolResult(editCheck) as Record<string, unknown>;

    expect(editData["status"]).toBe("clean");
    expect(editData["delta"]).toBeDefined();
    const delta = editData["delta"] as Record<string, unknown>;
    expect(delta["errorsResolved"]).toBe(1);
    expect(delta["errorsIntroduced"]).toBe(0);
    expect(delta["netDelta"]).toBe(-1);
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
