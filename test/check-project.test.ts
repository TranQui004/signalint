import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { isCheckResponse, type CheckResponse } from "../src/schema.js";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
});

describe("check_project MCP integration", () => {
  it("runs both real engines against the sample repository", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/src/index.js")],
    });
    const client = new Client({
      name: "signalint-phase-1-integration",
      version: "1.0.0",
    });
    clients.push(client);

    await client.connect(transport);
    const result = await client.callTool({
      name: "check_project",
      arguments: { paths: ["test/fixtures/sample-project"] },
    });
    const response = readResponse(result.content);

    expect(response.status).toBe("issues_found");
    expect(response.schemaVersion).toBe("1.1");
    expect(response.engines).toEqual({
      oxlint: { status: "ok" },
      tsc: { status: "ok" },
      biome: { status: "disabled" },
    });
    expect(response.totalIssues).toBe(2);
    expect(response.clusters).toHaveLength(2);
    expect(response.clusters.map((cluster) => cluster.priority)).toEqual([1, 2]);
    expect(response.clusters.every((cluster) => cluster.clusterId !== "")).toBe(true);
  });
});

function readResponse(content: unknown): CheckResponse {
  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0].text !== "string") {
    throw new Error("check_project did not return text content.");
  }

  const parsed: unknown = JSON.parse(content[0].text);
  if (!isCheckResponse(parsed)) {
    throw new Error("check_project did not return a Check Response.");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
