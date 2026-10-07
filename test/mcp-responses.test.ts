import { readFile, rm } from "node:fs/promises";
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
  type CheckResponse,
  type EngineStatuses,
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
    let currentIssues: NormalizedIssue[] = [issue, { ...issue, issueId: "other-issue-id" }];
    const client = await connectServer(() => Promise.resolve(currentIssues));

    const firstCheck = parseText(await callTool(client, "check_project", { paths: ["."] }));
    expect(isCheckResponse(firstCheck)).toBe(true);
    if (!isCheckResponse(firstCheck)) {
      throw new Error("Expected a Check Response.");
    }
    expect(firstCheck.schemaVersion).toBe("1.4");
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

  it("returns the exact per-engine error status on engine timeout", async () => {
    const timeoutError = new EngineTimeoutError("tsc", 120_000);
    const client = await connectServer(async () => ({
      issues: [],
      cache: { hits: 0, misses: 0 },
      engines: {
        oxlint: { status: "ok" },
        tsc: { status: "error", message: timeoutError.message },
        biome: { status: "disabled" },
        eslint: { status: "disabled" },
      },
    }));

    const response = parseText(
      await callTool(client, "check_project", { paths: ["."] }),
    );

    expect(isCheckResponse(response)).toBe(true);
    if (!isCheckResponse(response)) {
      throw new Error("Expected CheckResponse");
    }
    expect(response.status).toBe("error");
    expect(response.code).toBe("engine_failed");
    expect(response.engines.tsc).toEqual({
      status: "error",
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

  it("declares annotations with all four explicit boolean hints for every tool", async () => {
    const client = await connectServer(() => Promise.resolve([]));

    const toolsList = await client.listTools();
    expect(toolsList.tools).toHaveLength(5);
    for (const tool of toolsList.tools) {
      expect(tool.annotations, `${tool.name} missing annotations`).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, `${tool.name}.readOnlyHint`).toBe("boolean");
      expect(typeof tool.annotations?.destructiveHint, `${tool.name}.destructiveHint`).toBe("boolean");
      expect(typeof tool.annotations?.idempotentHint, `${tool.name}.idempotentHint`).toBe("boolean");
      expect(typeof tool.annotations?.openWorldHint, `${tool.name}.openWorldHint`).toBe("boolean");
      expect(tool.annotations?.readOnlyHint, `${tool.name}.readOnlyHint value`).toBe(true);
      expect(tool.annotations?.destructiveHint, `${tool.name}.destructiveHint value`).toBe(false);
      expect(tool.annotations?.idempotentHint, `${tool.name}.idempotentHint value`).toBe(true);
      expect(tool.annotations?.openWorldHint, `${tool.name}.openWorldHint value`).toBe(false);
    }
  });

  it("declares outputSchema for all five tools and returns matching structuredContent", async () => {
    const issue = makeIssue();
    const issue2 = { ...issue, issueId: "other-sample-issue" };
    const client = await connectServer(() => Promise.resolve([issue, issue2]));

    const toolsList = await client.listTools();
    expect(toolsList.tools).toHaveLength(5);
    for (const tool of toolsList.tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.type).toBe("object");
    }

    const pingResult = await client.callTool({ name: "ping", arguments: {} });
    expect(pingResult.structuredContent).toEqual({ pong: true, projectRoot: expect.any(String) });
    expect(pingResult.content).toEqual([{ type: "text", text: "pong" }]);

    const checkResult = await client.callTool({
      name: "check_project",
      arguments: { paths: ["."] },
    });
    expect(checkResult.structuredContent).toBeDefined();
    const checkParsed = parseText(checkResult.content);
    expect(checkResult.structuredContent).toEqual(checkParsed);
    expect(isCheckResponse(checkResult.structuredContent)).toBe(true);

    const clusterId = (checkResult.structuredContent as CheckResponse).clusters[0]?.clusterId;
    if (clusterId === undefined) {
      throw new Error("Expected clustered fixture issue.");
    }

    const checkId = (checkResult.structuredContent as CheckResponse).checkId;
    expect(typeof checkId).toBe("string");

    const detailWithValidCheckId = await client.callTool({
      name: "get_issue_detail",
      arguments: { clusterId, checkId },
    });
    expect(detailWithValidCheckId.structuredContent).toEqual({
      issues: [{ ...issue, clusterId }, { ...issue2, clusterId }],
    });

    const detailWithStaleCheckId = await client.callTool({
      name: "get_issue_detail",
      arguments: { clusterId, checkId: "stale-check-id" },
    });
    expect(detailWithStaleCheckId.structuredContent).toEqual({
      status: "stale",
      message: "This cluster/issue no longer exists; run check_project again.",
    });

    const detailResult = await client.callTool({
      name: "get_issue_detail",
      arguments: { clusterId },
    });
    expect(detailResult.structuredContent).toEqual({
      issues: [{ ...issue, clusterId }, { ...issue2, clusterId }],
    });
    expect(parseText(detailResult.content)).toEqual([{ ...issue, clusterId }, { ...issue2, clusterId }]);

    const loopResult = await client.callTool({
      name: "get_loop_status",
      arguments: {},
    });
    expect(loopResult.structuredContent).toEqual({ looping: false, signatures: [], fileChurning: false, fileRuleChurns: [] });
    expect(parseText(loopResult.content)).toEqual({ looping: false, signatures: [], fileChurning: false, fileRuleChurns: [] });
  });

  it("safely handles concurrent check calls without corrupting session state or JSONL logs", async () => {
    const memory = new SessionMemory({ logPath });
    const client = await connectServer(() => Promise.resolve([makeIssue()]), memory);

    const [res1, res2] = await Promise.all([
      client.callTool({ name: "check_project", arguments: { paths: ["."] } }),
      client.callTool({ name: "check_project", arguments: { paths: ["."] } }),
    ]);

    expect(isCheckResponse(res1.structuredContent)).toBe(true);
    expect(isCheckResponse(res2.structuredContent)).toBe(true);

    const content = await readFile(logPath, "utf8");
    const lines = content.trim().split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("delivers structuredContent on output-limit and invalid argument errors", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const limitClient = await connectServer(() =>
      Promise.reject(new EngineOutputLimitError("oxlint", 256)),
    );
    const limitResult = await limitClient.callTool({
      name: "check_project",
      arguments: { paths: ["."] },
    });
    expect(limitResult.isError).toBe(true);
    expect(limitResult.structuredContent).toEqual({
      status: "error",
      code: "engine_output_exceeded",
      engine: "oxlint",
      message: "oxlint output exceeded the 256 bytes limit",
    });

    const errorClient = await connectServer(() => Promise.resolve([]));
    const errorResult = await errorClient.callTool({
      name: "check_files",
      arguments: { files: ["../outside.ts"] },
    });
    expect(errorResult.isError).toBe(true);
    expect(errorResult.structuredContent).toEqual(
      expect.objectContaining({
        status: "error",
        code: "path_outside_project",
      }),
    );
  });

  it("serves minified MCP tool payloads without indentation or newlines across tools", async () => {
    const issue = makeIssue();
    const client = await connectServer(() => Promise.resolve([issue]));

    const checkProjectResult = (await client.callTool({
      name: "check_project",
      arguments: { paths: ["."] },
    })).content as Array<{ type: string; text: string }>;

    expect(checkProjectResult[0]?.text.includes("\n")).toBe(false);

    const checkFilesResult = (await client.callTool({
      name: "check_files",
      arguments: { files: ["src/current.ts"] },
    })).content as Array<{ type: string; text: string }>;

    expect(checkFilesResult[0]?.text.includes("\n")).toBe(false);

    const issueDetailResult = (await client.callTool({
      name: "get_issue_detail",
      arguments: { issueId: issue.issueId },
    })).content as Array<{ type: string; text: string }>;

    expect(issueDetailResult[0]?.text.includes("\n")).toBe(false);

    const loopStatusResult = (await client.callTool({
      name: "get_loop_status",
      arguments: {},
    })).content as Array<{ type: string; text: string }>;

    expect(loopStatusResult[0]?.text.includes("\n")).toBe(false);
  });
});

async function connectServer(
  provider: () => Promise<
    | NormalizedIssue[]
    | {
        issues: NormalizedIssue[];
        cache: { hits: number; misses: number };
        engines: EngineStatuses;
      }
  >,
  memory?: SessionMemory | undefined,
): Promise<Client> {
  const server = createServer({
    projectIssueProvider: provider,
    sessionMemory: memory ?? new SessionMemory({ logPath }),
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
