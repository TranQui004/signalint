import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { canonicalizePath } from "../src/projectPaths.js";
import { createServer } from "../src/server/createServer.js";
import { isRecord } from "../src/util/index.js";

const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(servers.map((s) => s.close()));
  clients.length = 0;
  servers.length = 0;
});

function parseToolResult(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) {
    throw new Error("Expected object tool result");
  }
  const content = result["content"];
  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0]["text"] !== "string") {
    throw new Error("Expected text tool result");
  }
  return JSON.parse(content[0]["text"]) as Record<string, unknown>;
}

describe("Live diagnostics and LSP ingestion MCP tools", () => {
  let tempDir: string;
  let canonicalRoot: string;
  const originalStateDir = process.env.SIGNALINT_STATE_DIR;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signalint-live-test-"));
    canonicalRoot = canonicalizePath(resolve(tempDir));
    process.env.SIGNALINT_STATE_DIR = canonicalRoot;
    // write package.json and tsconfig.json so it's a valid JS/TS project
    writeFileSync(resolve(canonicalRoot, "package.json"), JSON.stringify({ name: "test-pkg" }));
    writeFileSync(resolve(canonicalRoot, "tsconfig.json"), JSON.stringify({}));
    writeFileSync(resolve(canonicalRoot, "signalint.config.json"), JSON.stringify({}));
    writeFileSync(resolve(canonicalRoot, "index.ts"), "export const hello = 'world';\n");
    writeFileSync(resolve(canonicalRoot, "utils.ts"), "export const add = (a: number) => a;\n");
  });

  afterAll(() => {
    if (originalStateDir !== undefined) {
      process.env.SIGNALINT_STATE_DIR = originalStateDir;
    } else {
      delete process.env.SIGNALINT_STATE_DIR;
    }
    rmSync(canonicalRoot, { recursive: true, force: true });
  });

  it("ingests external LSP diagnostics, creates snapshot, and retrieves via get_diagnostic_snapshot", async () => {
    const server = createServer({ cwd: canonicalRoot });
    servers.push(server);

    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "lsp-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    const ingestRes = await client.callTool({
      name: "ingest_diagnostics",
      arguments: {
        source: "eslint",
        serverName: "eslint-lsp",
        diagnostics: [
          {
            file: "index.ts",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 10 },
            },
            severity: 1,
            code: "no-unused-vars",
            message: "'hello' is defined but never used.",
          },
        ],
      },
    });

    const ingestData = parseToolResult(ingestRes);
    expect(ingestData["snapshotId"]).toBeDefined();
    expect(ingestData["totalIssues"]).toBe(1);
    expect(Array.isArray(ingestData["clusters"])).toBe(true);

    const snapshotId = ingestData["snapshotId"] as string;

    // Retrieve via get_diagnostic_snapshot
    const snapRes = await client.callTool({
      name: "get_diagnostic_snapshot",
      arguments: { checkId: snapshotId },
    });
    const snapData = parseToolResult(snapRes);
    expect(snapData["checkId"]).toBe(snapshotId);
    expect(snapData["source"]).toBe("lsp");
    expect(snapData["totalIssues"]).toBe(1);
  });

  it("compares ingested LSP snapshot against compiler snapshot using compare_diagnostics", async () => {
    let callCount = 0;
    const server = createServer({
      cwd: canonicalRoot,
      fileIssueProvider: () => {
        callCount++;
        return Promise.resolve({
          issues: [
            {
              issueId: "compiler-id-1",
              file: "index.ts",
              line: 1,
              col: 1,
              engine: "tsc",
              rule: "TS2304",
              severity: "error",
              message: "Cannot find name 'foo'.",
              fixable: false,
            },
          ],
          cache: { hits: 0, misses: 1 },
          engines: { tsc: { status: "ok" } },
        });
      },
    });
    servers.push(server);

    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "compare-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    // 1. Run compiler check to create baseline snapshot
    const baselineRes = await client.callTool({
      name: "check_files",
      arguments: { files: ["index.ts"] },
    });
    const baselineData = parseToolResult(baselineRes);
    const baselineId = baselineData["checkId"] as string;

    // 2. Ingest LSP diagnostics representing fixed state
    const ingestRes = await client.callTool({
      name: "ingest_diagnostics",
      arguments: {
        serverName: "vtsls",
        diagnostics: [], // 0 issues, fixed!
      },
    });
    const ingestData = parseToolResult(ingestRes);
    const currentId = ingestData["snapshotId"] as string;

    // 3. Compare baseline compiler snapshot vs current LSP snapshot
    const compareRes = await client.callTool({
      name: "compare_diagnostics",
      arguments: { baselineCheckId: baselineId, currentCheckId: currentId },
    });
    const compareData = parseToolResult(compareRes);

    expect(compareData["status"]).toBe("ok");
    expect(compareData["errorsResolved"]).toBe(1);
    expect(compareData["errorsIntroduced"]).toBe(0);
    expect(compareData["netDelta"]).toBe(-1);
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it("merges internal engine issues and LSP diagnostics in get_live_diagnostics with clear provenance", async () => {
    const server = createServer({
      cwd: canonicalRoot,
      fileIssueProvider: () =>
        Promise.resolve({
          issues: [
            {
              issueId: "compiler-issue-1",
              file: "index.ts",
              line: 1,
              col: 1,
              engine: "tsc",
              rule: "TS2304",
              severity: "error",
              message: "Cannot find name 'foo'.",
              fixable: false,
            },
          ],
          cache: { hits: 0, misses: 1 },
          engines: { tsc: { status: "ok" } },
        }),
    });
    servers.push(server);

    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "live-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    // First run check_files to establish internal compiler issues
    await client.callTool({
      name: "check_files",
      arguments: { files: ["index.ts"] },
    });

    // Ingest LSP diagnostics on utils.ts
    await client.callTool({
      name: "ingest_diagnostics",
      arguments: {
        serverName: "vtsls",
        diagnostics: [
          {
            file: "utils.ts",
            range: {
              start: { line: 0, character: 15 },
              end: { line: 0, character: 25 },
            },
            severity: 2,
            code: "no-explicit-any",
            message: "Unexpected any type.",
          },
        ],
      },
    });

    // Query live diagnostics
    const liveRes = await client.callTool({
      name: "get_live_diagnostics",
      arguments: {},
    });
    const liveData = parseToolResult(liveRes);

    expect(liveData["status"]).toBe("issues_found");
    expect(liveData["totalIssues"]).toBe(2);

    const issues = liveData["issues"] as Array<Record<string, unknown>>;
    expect(issues.length).toBe(2);

    const tscIssue = issues.find((i) => i["engine"] === "tsc");
    expect(tscIssue).toBeDefined();
    expect(tscIssue?.["file"]).toBe("index.ts");

    const lspIssue = issues.find((i) => i["engine"] === "external-lsp");
    expect(lspIssue).toBeDefined();
    expect(lspIssue?.["file"]).toBe("utils.ts");
    expect(lspIssue?.["serverName"]).toBe("vtsls");

    // Filter by file
    const filteredRes = await client.callTool({
      name: "get_live_diagnostics",
      arguments: { files: ["index.ts"] },
    });
    const filteredData = parseToolResult(filteredRes);
    expect(filteredData["totalIssues"]).toBe(1);
    expect((filteredData["issues"] as Array<Record<string, unknown>>)[0]?.["file"]).toBe("index.ts");
  });

  it("rejects escaping paths in ingest_diagnostics with structured error", async () => {
    const server = createServer({ cwd: canonicalRoot });
    servers.push(server);

    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "escape-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    const ingestRes = await client.callTool({
      name: "ingest_diagnostics",
      arguments: {
        diagnostics: [
          {
            file: "../outside.ts",
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            message: "Outside project error",
          },
        ],
      },
    });

    expect(ingestRes.isError).toBe(true);
    const data = parseToolResult(ingestRes);
    expect(data["status"]).toBe("error");
    expect(data["code"]).toMatch(/path_outside_project|directory_traversal/);
  });
});
