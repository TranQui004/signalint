import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  filterDefaultExcludedIssues,
  isDefaultExcludedPath,
} from "../src/defaultExclusions.js";
import { createServer } from "../src/index.js";
import { SessionMemory } from "../src/memory/sessionMemory.js";
import {
  isCheckResponse,
  type CheckResponse,
  type IssueEngine,
  type NormalizedIssue,
} from "../src/schema.js";

const fixtureFile = resolve(
  "test/fixtures/node-modules-project/node_modules/broken-package/index.d.ts",
);
const logPath = resolve(".signalint/test/default-exclusions.jsonl");
const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(servers.map((server) => server.close()));
  clients.length = 0;
  servers.length = 0;
  await rm(logPath, { force: true });
});

describe("Default exclusions", () => {
  it("recognizes node_modules as a path segment on either platform", async () => {
    expect(await readFile(fixtureFile, "utf8")).toContain("illegalStatement");
    expect(isDefaultExcludedPath("backend/node_modules/pkg/index.d.ts")).toBe(true);
    expect(isDefaultExcludedPath("backend\\NODE_MODULES\\pkg\\index.d.ts")).toBe(true);
    expect(isDefaultExcludedPath("src/node_modules-helper.ts")).toBe(false);
  });

  it("filters node_modules diagnostics from every engine", () => {
    const issues = [
      makeIssue("oxlint-vendor", "backend/node_modules/a/index.d.ts", "oxlint"),
      makeIssue("tsc-vendor", "backend\\node_modules\\b\\index.d.ts", "tsc"),
      makeIssue("biome-vendor", "node_modules/c/index.js", "biome"),
      makeIssue("user-code", "src/node_modules-helper.ts", "tsc"),
    ];

    expect(filterDefaultExcludedIssues(issues).map((issue) => issue.issueId)).toEqual([
      "user-code",
    ]);
  });

  it("enforces the exclusion at the final check_project response boundary", async () => {
    const issues = [
      makeIssue("vendor-a", "backend/node_modules/a/index.d.ts", "oxlint"),
      makeIssue("vendor-b", "backend/node_modules/b/index.d.ts", "tsc"),
      makeIssue("user-code", "src/index.ts", "biome"),
    ];
    const server = createServer({
      projectIssueProvider: () => Promise.resolve(issues),
      sessionMemory: new SessionMemory({ logPath }),
    });
    servers.push(server);
    const client = await connectClient(server);
    const response = await callCheckProject(client);

    expect(response.totalIssues).toBe(1);
    expect(response.clusters).toHaveLength(1);
    expect(response.clusters[0]?.sampleIssueIds).toEqual(["user-code"]);
  });
});

async function connectClient(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "signalint-exclusion-test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function callCheckProject(client: Client): Promise<CheckResponse> {
  const result = await client.callTool({
    name: "check_project",
    arguments: { paths: ["."] },
  });
  if (!Array.isArray(result.content) || !isRecord(result.content[0])) {
    throw new Error("check_project did not return text content.");
  }
  const text = result.content[0].text;
  if (typeof text !== "string") {
    throw new Error("check_project did not return text content.");
  }
  const parsed: unknown = JSON.parse(text);
  if (!isCheckResponse(parsed)) {
    throw new Error("check_project did not return a Check Response.");
  }
  return parsed;
}

function makeIssue(issueId: string, file: string, engine: IssueEngine): NormalizedIssue {
  return {
    issueId,
    file,
    line: 1,
    col: 1,
    engine,
    rule: "fixture-rule",
    severity: "warning",
    message: "Fixture diagnostic",
    fixable: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
