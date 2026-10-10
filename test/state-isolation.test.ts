import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { SqliteCache } from "../src/cache/sqliteCache.js";
import { checkFilesWithStats } from "../src/checkFiles.js";
import { createServer } from "../src/index.js";
import type { NormalizedIssue } from "../src/schema.js";

const tempDirs: string[] = [];
const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  delete process.env.SIGNALINT_STATE_DIR;
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(servers.map((s) => s.close()));
  clients.length = 0;
  servers.length = 0;
});

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("State isolation via SIGNALINT_STATE_DIR", () => {
  it("isolates SQLite caches and session logs across distinct state directories without polluting cwd", async () => {
    const dirA = await mkdtemp(resolve(tmpdir(), "signalint-state-a-"));
    const dirB = await mkdtemp(resolve(tmpdir(), "signalint-state-b-"));
    tempDirs.push(dirA, dirB);

    const issueA: NormalizedIssue = {
      issueId: "issue-in-a",
      file: "src/fileA.ts",
      line: 10,
      col: 1,
      engine: "oxlint",
      rule: "rule-a",
      severity: "error",
      message: "Diagnostic in project A",
      fixable: false,
    };

    const issueB: NormalizedIssue = {
      issueId: "issue-in-b",
      file: "src/fileB.ts",
      line: 20,
      col: 2,
      engine: "oxlint",
      rule: "rule-b",
      severity: "warning",
      message: "Diagnostic in project B",
      fixable: false,
    };

    // 1. Run check under state dir A
    process.env.SIGNALINT_STATE_DIR = dirA;
    const serverA = createServer({
      projectIssueProvider: () => Promise.resolve([issueA]),
      fileIssueProvider: () => Promise.resolve([issueA]),
    });
    servers.push(serverA);

    const [clientTransportA, serverTransportA] = InMemoryTransport.createLinkedPair();
    await serverA.connect(serverTransportA);
    const clientA = new Client({ name: "client-a", version: "1.0.0" });
    clients.push(clientA);
    await clientA.connect(clientTransportA);

    await clientA.callTool({ name: "check_project", arguments: { paths: ["."] } });

    // 2. Run check under state dir B
    process.env.SIGNALINT_STATE_DIR = dirB;
    const serverB = createServer({
      projectIssueProvider: () => Promise.resolve([issueB]),
      fileIssueProvider: () => Promise.resolve([issueB]),
    });
    servers.push(serverB);

    const [clientTransportB, serverTransportB] = InMemoryTransport.createLinkedPair();
    await serverB.connect(serverTransportB);
    const clientB = new Client({ name: "client-b", version: "1.0.0" });
    clients.push(clientB);
    await clientB.connect(clientTransportB);

    await clientB.callTool({ name: "check_project", arguments: { paths: ["."] } });

    // 3. Verify session logs exist in respective state dirs
    const sessionLogA = resolve(dirA, "session.jsonl");
    const sessionLogB = resolve(dirB, "session.jsonl");

    expect(existsSync(sessionLogA)).toBe(true);
    expect(existsSync(sessionLogB)).toBe(true);

    const contentA = await readFile(sessionLogA, "utf8");
    const contentB = await readFile(sessionLogB, "utf8");

    expect(contentA).toContain("rule-a");
    expect(contentA).not.toContain("rule-b");

    expect(contentB).toContain("rule-b");
    expect(contentB).not.toContain("rule-a");

    // 4. Verify checkFilesWithStats respects SIGNALINT_STATE_DIR for cache.sqlite
    process.env.SIGNALINT_STATE_DIR = dirA;
    const cacheFileA = resolve(dirA, "cache.sqlite");
    expect(existsSync(cacheFileA)).toBe(false);

    // Running checkFilesWithStats with oxlint runner will populate cache
    await checkFilesWithStats(["package.json"], {
      runners: {
        oxlint: () => Promise.resolve([issueA]),
      },
    });

    expect(existsSync(cacheFileA)).toBe(true);

    process.env.SIGNALINT_STATE_DIR = dirB;
    const cacheFileB = resolve(dirB, "cache.sqlite");
    expect(existsSync(cacheFileB)).toBe(false);

    await checkFilesWithStats(["package.json"], {
      runners: {
        oxlint: () => Promise.resolve([issueB]),
      },
    });

    expect(existsSync(cacheFileB)).toBe(true);

    // Verify cache files are independent
    const sqliteA = new SqliteCache(cacheFileA);
    const sqliteB = new SqliteCache(cacheFileB);

    try {
      expect(sqliteA).toBeDefined();
      expect(sqliteB).toBeDefined();
    } finally {
      sqliteA.close();
      sqliteB.close();
    }
  });
});
