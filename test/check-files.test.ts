import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";
import { isCheckResponse, type CheckResponse } from "../src/schema.js";

const fixtureRoot = resolve("test/fixtures/three-errors-project");
const fixtureCache = resolve(fixtureRoot, ".signalint");
const testStateDir = mkdtempSync(resolve(tmpdir(), "signalint-test-checkfiles-"));
const clients: Client[] = [];
const servers: Server[] = [];

beforeAll(() => {
  process.env.SIGNALINT_STATE_DIR = testStateDir;
});

afterAll(async () => {
  delete process.env.SIGNALINT_STATE_DIR;
  await rm(testStateDir, { recursive: true, force: true }).catch(() => {});
  await rm(fixtureCache, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(servers.map((server) => server.close()));
  clients.length = 0;
  await rm(fixtureCache, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
});

describe("check_files scope filtering", () => {
  it("filters returned issues down to requested file scope and surfaces filtered-out count", async () => {
    const server = createServer({ cwd: fixtureRoot });
    servers.push(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-check-files", version: "1.0.0" });
    await client.connect(clientTransport);
    clients.push(client);

    // 1. check_files([a]) returns exactly the issue in a
    const firstCheckResult = await client.callTool({
      name: "check_files",
      arguments: { files: ["src/a.ts"] },
    });
    const firstResponse = parseResponse(firstCheckResult.content);

    expect(isCheckResponse(firstResponse)).toBe(true);
    expect(firstResponse.totalIssues).toBe(1);
    expect(firstResponse.remainingIssues).toHaveLength(1);
    expect(firstResponse.remainingIssues?.[0]?.file).toBe("src/a.ts");
    expect(firstResponse.clusters).toHaveLength(0);

    // 2. The filtered-out count is reported and is 2 for check_files([a])
    expect(firstResponse.filteredOutIssueCount).toBe(2);
    expect(firstResponse.filteredOutCount).toBe(2);
    expect(firstResponse.nextStep).toContain("check_project");

    // 3. Warm-cache path: call check_files([a]) twice; both calls return identical scope
    const secondCheckResult = await client.callTool({
      name: "check_files",
      arguments: { files: ["src/a.ts"] },
    });
    const secondResponse = parseResponse(secondCheckResult.content);

    expect(isCheckResponse(secondResponse)).toBe(true);
    expect(secondResponse.totalIssues).toBe(1);
    expect(secondResponse.remainingIssues).toHaveLength(1);
    expect(secondResponse.remainingIssues?.[0]?.file).toBe("src/a.ts");
    expect(secondResponse.filteredOutIssueCount).toBe(2);
    expect(secondResponse.filteredOutCount).toBe(2);
    expect(secondResponse.nextStep).toContain("check_project");

    // 4. check_project on the same project returns all three
    const projectCheckResult = await client.callTool({
      name: "check_project",
      arguments: {},
    });
    const projectResponse = parseResponse(projectCheckResult.content);

    expect(isCheckResponse(projectResponse)).toBe(true);
    expect(projectResponse.totalIssues).toBe(3);
    expect(projectResponse.clusters).toHaveLength(1);
    expect(projectResponse.clusters[0]?.issueCount).toBe(3);
    expect(projectResponse.clusters[0]?.fileCount).toBe(3);

    const clusterDetailResult = await client.callTool({
      name: "get_issue_detail",
      arguments: { clusterId: projectResponse.clusters[0]!.clusterId },
    });
    const firstDetailContent = Array.isArray(clusterDetailResult.content)
      ? clusterDetailResult.content[0]
      : undefined;
    if (
      !firstDetailContent ||
      typeof firstDetailContent !== "object" ||
      !("text" in firstDetailContent) ||
      typeof firstDetailContent.text !== "string"
    ) {
      throw new Error("Missing cluster detail text");
    }
    const rawClusterIssues: unknown = JSON.parse(firstDetailContent.text);
    if (!Array.isArray(rawClusterIssues)) {
      throw new Error("Expected array of issues in cluster detail");
    }
    const clusterFiles = rawClusterIssues
      .filter((item): item is { file: string } => typeof item === "object" && item !== null && typeof item.file === "string")
      .map((i) => i.file)
      .sort();
    expect(clusterFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(projectResponse.filteredOutIssueCount).toBeUndefined();
  });

  it("operates over real stdio transport against three-error fixture", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/src/index.js")],
      cwd: fixtureRoot,
      env: { ...process.env, SIGNALINT_STATE_DIR: testStateDir },
    });
    const client = new Client({ name: "test-check-files-stdio", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const checkResult = await client.callTool({
      name: "check_files",
      arguments: { files: ["src/a.ts"] },
    });
    const response = parseResponse(checkResult.content);

    expect(response.totalIssues).toBe(1);
    expect(response.remainingIssues?.[0]?.file).toBe("src/a.ts");
    expect(response.filteredOutIssueCount).toBe(2);
    expect(response.nextStep).toContain("check_project");
  });
});

function parseResponse(content: unknown): CheckResponse {
  if (!Array.isArray(content) || !content[0] || typeof content[0].text !== "string") {
    throw new Error("Tool did not return text content.");
  }
  const parsed: unknown = JSON.parse(content[0].text);
  if (!isCheckResponse(parsed)) {
    throw new Error("Invalid CheckResponse payload");
  }
  return parsed;
}
