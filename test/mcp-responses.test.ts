import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { checkProjectWithIssues } from "../src/check/checkProject.js";
import type { McpPayloadMode } from "../src/config.js";
import { createServer } from "../src/index.js";
import { SessionMemory } from "../src/memory/sessionMemory.js";
import { createHumanSummary } from "../src/server/errors.js";
import { resolveToolOutputSchema } from "../src/server/toolSchemas.js";
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

const responseTestDir = mkdtempSync(resolve(tmpdir(), "signalint-test-mcp-responses-"));
const logPath = resolve(responseTestDir, "mcp-responses.jsonl");
const clients: Client[] = [];
const servers: Server[] = [];

afterAll(async () => {
  await rm(responseTestDir, { force: true, recursive: true });
});

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

  it("resolves both short id and full 64-char id through get_issue_detail", async () => {
    const fullId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const issue: NormalizedIssue = {
      ...makeIssue(),
      issueId: fullId,
    };
    const client = await connectServer(async () => [issue]);

    const checkResult = parseText(await callTool(client, "check_project", { paths: ["."] })) as CheckResponse;
    expect(checkResult.remainingIssues).toHaveLength(1);
    const shortId = checkResult.remainingIssues?.[0]?.issueId;
    expect(shortId).toBe(fullId.slice(0, 12));

    const shortDetail = parseText(await callTool(client, "get_issue_detail", { issueId: shortId }));
    expect(Array.isArray(shortDetail)).toBe(true);
    expect(shortDetail).toHaveLength(1);
    expect((shortDetail as NormalizedIssue[])[0]?.issueId).toBe(fullId);

    const fullDetail = parseText(await callTool(client, "get_issue_detail", { issueId: fullId }));
    expect(Array.isArray(fullDetail)).toBe(true);
    expect(fullDetail).toHaveLength(1);
    expect((fullDetail as NormalizedIssue[])[0]?.issueId).toBe(fullId);
  });

  it("resolves two colliding 12-char prefix issues correctly without shadowing", async () => {
    const prefix12 = "abcdef012345";
    const fullIdA = `${prefix12}0000000000000000000000000000000000000000000000000000`;
    const fullIdB = `${prefix12}1111111111111111111111111111111111111111111111111111`;
    const issueA: NormalizedIssue = {
      ...makeIssue(),
      issueId: fullIdA,
      file: "src/a.ts",
    };
    const issueB: NormalizedIssue = {
      ...makeIssue(),
      issueId: fullIdB,
      file: "src/b.ts",
      rule: "fixture-rule-b",
    };
    const client = await connectServer(async () => [issueA, issueB]);

    const checkResult = parseText(await callTool(client, "check_project", { paths: ["."] })) as CheckResponse;
    expect(checkResult.remainingIssues).toHaveLength(2);

    const emittedIdA = checkResult.remainingIssues?.find((i) => i.file === "src/a.ts")?.issueId;
    const emittedIdB = checkResult.remainingIssues?.find((i) => i.file === "src/b.ts")?.issueId;

    expect(emittedIdA).toBeDefined();
    expect(emittedIdB).toBeDefined();
    expect(emittedIdA).not.toBe(emittedIdB);
    expect(emittedIdA).toBe(`${prefix12}0`);
    expect(emittedIdB).toBe(`${prefix12}1`);

    const detailA = parseText(await callTool(client, "get_issue_detail", { issueId: emittedIdA })) as NormalizedIssue[];
    expect(detailA).toHaveLength(1);
    expect(detailA[0]?.issueId).toBe(fullIdA);
    expect(detailA[0]?.file).toBe("src/a.ts");

    const detailB = parseText(await callTool(client, "get_issue_detail", { issueId: emittedIdB })) as NormalizedIssue[];
    expect(detailB).toHaveLength(1);
    expect(detailB[0]?.issueId).toBe(fullIdB);
    expect(detailB[0]?.file).toBe("src/b.ts");

    const detailFullA = parseText(await callTool(client, "get_issue_detail", { issueId: fullIdA })) as NormalizedIssue[];
    expect(detailFullA).toHaveLength(1);
    expect(detailFullA[0]?.issueId).toBe(fullIdA);

    const detailFullB = parseText(await callTool(client, "get_issue_detail", { issueId: fullIdB })) as NormalizedIssue[];
    expect(detailFullB).toHaveLength(1);
    expect(detailFullB[0]?.issueId).toBe(fullIdB);
  });
});

describe("configurable MCP payload modes across tools", () => {
  it("defaults to both mode, preserving byte-for-byte response shape and outputSchema", async () => {
    const issue = makeIssue();
    const client = await connectServer(() => Promise.resolve([issue]), undefined, "both");

    const toolsList = await client.listTools();
    expect(toolsList.tools).toHaveLength(5);
    for (const tool of toolsList.tools) {
      expect(tool.outputSchema).toBeDefined();
    }

    // 1. ping
    const pingRes = await client.callTool({ name: "ping", arguments: {} });
    expect(pingRes.structuredContent).toEqual({ pong: true, projectRoot: expect.any(String) });
    expect(pingRes.content).toEqual([{ type: "text", text: "pong" }]);

    // 2. check_project
    const checkRes = await client.callTool({ name: "check_project", arguments: { paths: ["."] } });
    expect(checkRes.structuredContent).toBeDefined();
    const checkText = getFirstText(checkRes.content);
    expect(checkText).not.toContain("\n");
    expect(JSON.parse(checkText)).toEqual(checkRes.structuredContent);

    // 3. check_files
    const checkFilesRes = await client.callTool({ name: "check_files", arguments: { files: ["package.json"] } });
    expect(checkFilesRes.structuredContent).toBeDefined();
    const filesText = getFirstText(checkFilesRes.content);
    expect(filesText).not.toContain("\n");
    expect(JSON.parse(filesText)).toEqual(checkFilesRes.structuredContent);

    // 4. get_issue_detail
    const detailRes = await client.callTool({ name: "get_issue_detail", arguments: { issueId: issue.issueId } });
    const detailText = getFirstText(detailRes.content);
    expect(detailText).not.toContain("\n");
    expect(detailRes.structuredContent).toEqual({ issues: JSON.parse(detailText) });

    // 5. get_loop_status
    const loopRes = await client.callTool({ name: "get_loop_status", arguments: {} });
    expect(loopRes.structuredContent).toBeDefined();
    const loopText = getFirstText(loopRes.content);
    expect(loopText).not.toContain("\n");
    expect(JSON.parse(loopText)).toEqual(loopRes.structuredContent);
  });

  it("emits only text content and suppresses structuredContent and outputSchema in text mode", async () => {
    const issue = makeIssue();
    const client = await connectServer(() => Promise.resolve([issue]), undefined, "text");

    const toolsList = await client.listTools();
    expect(toolsList.tools).toHaveLength(5);
    for (const tool of toolsList.tools) {
      expect(tool.outputSchema).toBeUndefined();
    }

    // 1. ping
    const pingRes = await client.callTool({ name: "ping", arguments: {} });
    expect("structuredContent" in pingRes).toBe(false);
    expect(pingRes.content).toEqual([{ type: "text", text: "pong" }]);

    // 2. check_project
    const checkRes = await client.callTool({ name: "check_project", arguments: { paths: ["."] } });
    expect("structuredContent" in checkRes).toBe(false);
    const checkText = getFirstText(checkRes.content);
    expect(checkText).not.toContain("\n");
    const parsedCheck = JSON.parse(checkText) as CheckResponse;
    expect(parsedCheck.status).toBe("issues_found");
    expect(parsedCheck.totalIssues).toBe(1);

    // 3. check_files
    const checkFilesRes = await client.callTool({ name: "check_files", arguments: { files: ["package.json"] } });
    expect("structuredContent" in checkFilesRes).toBe(false);
    const filesText = getFirstText(checkFilesRes.content);
    expect(filesText).not.toContain("\n");
    expect(JSON.parse(filesText)).toMatchObject({ status: "issues_found" });

    // 4. get_issue_detail
    const detailRes = await client.callTool({ name: "get_issue_detail", arguments: { issueId: issue.issueId } });
    expect("structuredContent" in detailRes).toBe(false);
    const detailText = getFirstText(detailRes.content);
    expect(detailText).not.toContain("\n");
    expect(JSON.parse(detailText)).toHaveLength(1);

    // 5. get_loop_status
    const loopRes = await client.callTool({ name: "get_loop_status", arguments: {} });
    expect("structuredContent" in loopRes).toBe(false);
    const loopText = getFirstText(loopRes.content);
    expect(loopText).not.toContain("\n");
    expect(JSON.parse(loopText)).toMatchObject({ looping: false });
  });

  it("emits structuredContent and single-line human summary without newlines in structured mode", async () => {
    const issue = makeIssue();
    const client = await connectServer(() => Promise.resolve([issue]), undefined, "structured");

    const toolsList = await client.listTools();
    expect(toolsList.tools).toHaveLength(5);
    for (const tool of toolsList.tools) {
      expect(tool.outputSchema).toBeDefined();
    }

    // 1. ping
    const pingRes = await client.callTool({ name: "ping", arguments: {} });
    expect(pingRes.structuredContent).toEqual({ pong: true, projectRoot: expect.any(String) });
    expect(pingRes.content).toEqual([{ type: "text", text: "pong" }]);

    // 2. check_project
    const checkRes = await client.callTool({ name: "check_project", arguments: { paths: ["."] } });
    expect(checkRes.structuredContent).toBeDefined();
    expect(isCheckResponse(checkRes.structuredContent)).toBe(true);
    const checkText = getFirstText(checkRes.content);
    expect(checkText).not.toContain("\n");
    expect(checkText).not.toContain("{");
    expect(checkText).toBe("1 issue found.");

    // 3. check_files
    const checkFilesRes = await client.callTool({ name: "check_files", arguments: { files: ["package.json"] } });
    expect(checkFilesRes.structuredContent).toBeDefined();
    const filesText = getFirstText(checkFilesRes.content);
    expect(filesText).not.toContain("\n");
    expect(filesText).toBe("1 issue found.");

    // 4. get_issue_detail
    const detailRes = await client.callTool({ name: "get_issue_detail", arguments: { issueId: issue.issueId } });
    expect(detailRes.structuredContent).toBeDefined();
    const detailText = getFirstText(detailRes.content);
    expect(detailText).not.toContain("\n");
    expect(detailText).not.toContain("{");
    expect(detailText).toBe("Found 1 issue.");

    // 5. get_loop_status
    const loopRes = await client.callTool({ name: "get_loop_status", arguments: {} });
    expect(loopRes.structuredContent).toBeDefined();
    const loopText = getFirstText(loopRes.content);
    expect(loopText).not.toContain("\n");
    expect(loopText).not.toContain("{");
    expect(loopText).toBe("No loops detected.");
  });

  it("formats human summaries correctly and handles all summary variants without newlines", () => {
    expect(createHumanSummary([])).toBe("Found 0 issues.");
    expect(createHumanSummary([makeIssue()])).toBe("Found 1 issue.");
    expect(createHumanSummary({ status: "clean" })).toBe("Clean: 0 issues found.");
    expect(createHumanSummary({ status: "issues_found", totalIssues: 5 })).toBe("5 issues found.");
    expect(createHumanSummary({ status: "error", message: "Failed\ncheck" })).toBe("Error: Failed check");
    expect(createHumanSummary({ status: "error", code: "engine_failed" })).toBe("Error: engine_failed");
    expect(createHumanSummary({ status: "stale", message: "Expired\nreference" })).toBe("Stale: Expired reference");
    expect(createHumanSummary({ looping: true })).toBe("Looping detected.");
    expect(createHumanSummary({ message: "Hello\r\nWorld" })).toBe("Hello World");
    expect(createHumanSummary({ other: 123 })).toBe("OK");
    expect(createHumanSummary("not an object")).toBe("OK");
  });

  it("resolves tool output schema only when structured content is enabled", () => {
    const dummySchema = { type: "object" };
    expect(resolveToolOutputSchema(dummySchema, "text")).toBeUndefined();
    expect(resolveToolOutputSchema(dummySchema, "both")).toBe(dummySchema);
    expect(resolveToolOutputSchema(dummySchema, "structured")).toBe(dummySchema);
  });

  it("omits loopWarning and fileRuleChurnWarning keys on clean project", async () => {
    const client = await connectServer(() => Promise.resolve([]));
    const result = await client.callTool({ name: "check_project", arguments: { paths: ["."] } });
    const text = getFirstText(result.content);
    const parsed = JSON.parse(text) as Record<string, unknown>;

    expect("loopWarning" in parsed).toBe(false);
    expect("fileRuleChurnWarning" in parsed).toBe(false);
    if (result.structuredContent !== undefined) {
      const structured = result.structuredContent as Record<string, unknown>;
      expect("loopWarning" in structured).toBe(false);
      expect("fileRuleChurnWarning" in structured).toBe(false);
    }
  });

  it("emits loopWarning when an issue oscillates and triggers loop detection", async () => {
    const issue = makeIssue();
    let currentIssues: NormalizedIssue[] = [issue];
    const client = await connectServer(() => Promise.resolve(currentIssues));

    // 1: issue present
    await client.callTool({ name: "check_project", arguments: { paths: ["."] } });
    // 2: fixed
    currentIssues = [];
    await client.callTool({ name: "check_project", arguments: { paths: ["."] } });
    // 3: reappears (1st reappearance, below threshold)
    currentIssues = [issue];
    const thirdRes = await client.callTool({ name: "check_project", arguments: { paths: ["."] } });
    const thirdParsed = JSON.parse(getFirstText(thirdRes.content)) as Record<string, unknown>;
    expect("loopWarning" in thirdParsed).toBe(false);

    // 4: fixed
    currentIssues = [];
    await client.callTool({ name: "check_project", arguments: { paths: ["."] } });
    // 5: reappears (2nd reappearance, triggers loop warning)
    currentIssues = [issue];
    const fifthRes = await client.callTool({ name: "check_project", arguments: { paths: ["."] } });
    const fifthParsed = JSON.parse(getFirstText(fifthRes.content)) as Record<string, unknown>;
    expect("loopWarning" in fifthParsed).toBe(true);
    expect(fifthParsed.loopWarning).toBeDefined();
    expect(fifthParsed.loopWarning).not.toBeNull();
  });

  it("serializes identical bytes between CLI check response and MCP check_project text", async () => {
    const paths = ["test/fixtures/sample-project"];
    const cliResult = await checkProjectWithIssues(paths, process.cwd());
    const cliSerialized = JSON.stringify(cliResult.response);

    const client = await connectServer(
      () =>
        Promise.resolve({
          issues: cliResult.issues,
          cache: { hits: 0, misses: 0 },
          engines: cliResult.response.engines,
        }),
      undefined,
      "both",
    );

    const mcpRes = await client.callTool({
      name: "check_project",
      arguments: { paths },
    });
    const mcpText = getFirstText(mcpRes.content);

    expect(Buffer.byteLength(mcpText)).toBe(Buffer.byteLength(cliSerialized));
    expect(JSON.parse(mcpText)).toEqual(cliResult.response);
  });
});

function getFirstText(content: unknown): string {
  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0].text !== "string") {
    throw new Error("MCP tool did not return text content.");
  }
  return content[0].text;
}

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
  payloadMode?: McpPayloadMode | undefined,
  cwd?: string | undefined,
): Promise<Client> {
  const server = createServer({
    cwd,
    projectIssueProvider: provider,
    fileIssueProvider: provider,
    sessionMemory: memory ?? new SessionMemory({ logPath }),
    payloadMode,
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
