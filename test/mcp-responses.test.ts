import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../src/index.js";
import { SessionMemory } from "../src/memory/sessionMemory.js";
import {
  isCheckResponse,
  isEngineOutputLimitResponse,
  isNormalizedIssue,
  isStaleReferenceResponse,
  isTimeoutResponse,
  type NormalizedIssue,
} from "../src/schema.js";
import {
  EngineExecutionError,
  EngineOutputLimitError,
  EngineTimeoutError,
} from "../src/subprocess.js";

const logPath = resolve(".signalint/test/mcp-responses.jsonl");
const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(servers.map((server) => server.close()));
  clients.length = 0;
  servers.length = 0;
  await rm(logPath, { force: true });
});

describe("MCP response amendments", () => {
  it("versions check responses and returns stale for expired cluster and issue IDs", async () => {
    const issue = makeIssue();
    let currentIssues: NormalizedIssue[] = [issue];
    const client = await connectServer(() => Promise.resolve(currentIssues));

    const firstCheck = parseText(await callTool(client, "check_project", { paths: ["."] }));
    expect(isCheckResponse(firstCheck)).toBe(true);
    if (!isCheckResponse(firstCheck)) {
      throw new Error("Expected a Check Response.");
    }
    expect(firstCheck.schemaVersion).toBe("1.0");
    const clusterId = firstCheck.clusters[0]?.clusterId;
    if (clusterId === undefined) {
      throw new Error("Expected a clustered fixture issue.");
    }

    const currentDetail = parseText(
      await callTool(client, "get_issue_detail", { clusterId }),
    );
    expect(Array.isArray(currentDetail)).toBe(true);
    expect(Array.isArray(currentDetail) && currentDetail.every(isNormalizedIssue)).toBe(true);

    currentIssues = [];
    await callTool(client, "check_project", { paths: ["."] });
    for (const reference of [{ clusterId }, { issueId: issue.issueId }]) {
      const stale = parseText(await callTool(client, "get_issue_detail", reference));
      expect(isStaleReferenceResponse(stale)).toBe(true);
      expect(stale).toEqual({
        status: "stale",
        message: "This cluster/issue no longer exists; run check_project again.",
      });
    }
  });

  it("returns the exact structured timeout response from check_project", async () => {
    const client = await connectServer(() =>
      Promise.reject(new EngineTimeoutError("tsc", 120_000)),
    );

    const response = parseText(
      await callTool(client, "check_project", { paths: ["."] }),
    );

    expect(isTimeoutResponse(response)).toBe(true);
    expect(response).toEqual({
      status: "timeout",
      engine: "tsc",
      message: "tsc did not complete within 120s",
    });
  });

  it("logs attributed non-timeout engine failures to stderr before rethrowing", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const client = await connectServer(() =>
      Promise.reject(new EngineExecutionError("oxlint", new Error("fixture failure"))),
    );

    await expect(callTool(client, "check_project", { paths: ["."] })).rejects.toThrow();

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("engine=oxlint"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("fixture failure"));
    expect(stdout).not.toHaveBeenCalled();
  });

  it("returns a structured error when engine output exceeds its byte ceiling", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const client = await connectServer(() =>
      Promise.reject(new EngineOutputLimitError("biome", 128)),
    );

    const response = parseText(
      await callTool(client, "check_project", { paths: ["."] }),
    );

    expect(isEngineOutputLimitResponse(response)).toBe(true);
    expect(response).toEqual({
      status: "error",
      code: "engine_output_exceeded",
      engine: "biome",
      message: "biome output exceeded the 128 bytes limit",
    });
  });
});

async function connectServer(
  provider: () => Promise<NormalizedIssue[]>,
): Promise<Client> {
  const server = createServer({
    projectIssueProvider: provider,
    sessionMemory: new SessionMemory({ logPath }),
  });
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "signalint-response-test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<unknown> {
  return (await client.callTool({ name, arguments: argumentsValue })).content;
}

function parseText(content: unknown): unknown {
  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0].text !== "string") {
    throw new Error("MCP tool did not return text content.");
  }
  return JSON.parse(content[0].text) as unknown;
}

function makeIssue(): NormalizedIssue {
  return {
    issueId: "current-issue",
    file: "src/current.ts",
    line: 1,
    col: 1,
    engine: "oxlint",
    rule: "fixture-rule",
    severity: "warning",
    message: "Fixture diagnostic",
    fixable: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
