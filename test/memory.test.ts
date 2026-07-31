import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../src/index.js";
import {
  createIssueSignature,
  normalizeSignatureMessage,
  SessionMemory,
} from "../src/memory/sessionMemory.js";
import {
  createSuccessfulEngineStatuses,
  isCheckResponse,
  isLoopStatus,
  type CheckResponse,
  type LoopStatus,
  type NormalizedIssue,
} from "../src/schema.js";

const logPath = resolve(".signalint/test/session-memory.jsonl");
const rotatedLogPath = `${logPath}.1`;
const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(servers.map((server) => server.close()));
  clients.length = 0;
  servers.length = 0;
  await rm(logPath, { force: true });
  await rm(rotatedLogPath, { force: true });
});

describe("Session Memory", () => {
  it("normalizes changing identifiers and numeric locations into one signature", () => {
    const first = makeIssue(
      "A",
      "no-unused-vars",
      "Variable 'firstName' is unused at line 42",
    );
    const second = makeIssue(
      "B",
      "no-unused-vars",
      "Variable 'otherName' is unused at line 99",
    );

    expect(normalizeSignatureMessage(first.message)).toBe(
      "variable <identifier> is unused at line <number>",
    );
    expect(createIssueSignature(first)).toBe(createIssueSignature(second));
  });

  it("flags the second A-B oscillation through the real MCP handlers", async () => {
    await rm(logPath, { force: true });
    const issueA = makeIssue("A", "rule-a", "Variable 'alpha' failed at line 10");
    const issueB = makeIssue("B", "rule-b", "Property 'beta' failed at line 20");
    const sequence = [[issueA], [issueB], [issueA], [issueB], [issueA]];
    let sequenceIndex = 0;
    let timestamp = 1000;
    const sessionMemory = new SessionMemory({
      logPath,
      now: () => {
        timestamp += 1;
        return timestamp;
      },
    });
    const server = createServer({
      fileIssueProvider: () => Promise.resolve(sequence[sequenceIndex++] ?? []),
      sessionMemory,
    });
    servers.push(server);
    const client = await connectClient(server);

    const responses: CheckResponse[] = [];
    for (let index = 0; index < sequence.length; index += 1) {
      responses.push(await callCheckFiles(client));
    }
    const status = await callLoopStatus(client);
    const logLines = (await readFile(logPath, "utf8")).trim().split(/\r?\n/);

    expect(responses[2]?.loopWarning).toBeNull();
    expect(responses[4]?.loopWarning).toMatchObject({
      signature: createIssueSignature(issueA),
      occurrences: 2,
    });
    expect(status.looping).toBe(true);
    expect(status.signatures).toHaveLength(1);
    expect(status.signatures[0]?.signature).toBe(createIssueSignature(issueA));
    expect(logLines).toHaveLength(5);
    const finalLogEntry: unknown = JSON.parse(logLines[4] ?? "null");
    if (!isRecord(finalLogEntry) || !isRecord(finalLogEntry.metrics)) {
      throw new Error("Session log did not include measurement metrics.");
    }
    expect(finalLogEntry.metrics).toMatchObject({
      cacheHits: 0,
      cacheMisses: 0,
    });
    expect(typeof finalLogEntry.metrics.rawPayloadBytes).toBe("number");
    expect(typeof finalLogEntry.metrics.clusteredPayloadBytes).toBe("number");
    expect(typeof finalLogEntry.metrics.latencyMs).toBe("number");
    console.info(JSON.stringify({ firstOscillation: responses[2], secondOscillation: responses[4], status }));
  });

  it("restores loop history and skips a truncated final JSONL entry", async () => {
    await rm(logPath, { force: true });
    const issueA = makeIssue("A", "rule-a", "Variable 'alpha' failed at line 10");
    const issueB = makeIssue("B", "rule-b", "Property 'beta' failed at line 20");
    let timestamp = 2000;
    const firstSession = new SessionMemory({
      logPath,
      now: () => {
        timestamp += 1;
        return timestamp;
      },
    });
    await recordIssues(firstSession, [issueA]);
    await recordIssues(firstSession, [issueB]);
    await recordIssues(firstSession, [issueA]);
    expect(firstSession.getStatus().looping).toBe(false);

    await appendFile(logPath, '{"timestamp":', "utf8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const restoredSession = new SessionMemory({
      logPath,
      now: () => {
        timestamp += 1;
        return timestamp;
      },
    });
    expect(stderr).toHaveBeenCalledWith(
      "[signalint] Skipped 1 malformed session log line(s).\n",
    );
    expect(restoredSession.getStatus().looping).toBe(false);
    await recordIssues(restoredSession, [issueB]);
    const secondOscillation = await recordIssues(restoredSession, [issueA]);

    expect(secondOscillation.loopWarning).toMatchObject({
      signature: createIssueSignature(issueA),
      occurrences: 2,
    });
    expect(new SessionMemory({ logPath }).getStatus()).toMatchObject({
      looping: true,
      signatures: [{ signature: createIssueSignature(issueA), occurrences: 2 }],
    });
  });

  it("replays only the configured recent tail of session history", async () => {
    const issueA = makeIssue("A", "rule-a", "Variable 'alpha' failed at line 10");
    const signatureA = createIssueSignature(issueA);
    const history = [
      createReplayLine(1, [signatureA]),
      createReplayLine(2, []),
      createReplayLine(3, [signatureA]),
      createReplayLine(4, []),
      createReplayLine(5, [signatureA]),
      createReplayLine(6, ["recent-signature"]),
    ];
    await writeFile(logPath, `${history.join("\n")}\n`, "utf8");

    const memory = new SessionMemory({
      logPath,
      maxReplayEntries: 2,
      maxLogBytes: 1024 * 1024,
    });

    expect(memory.getStatus()).toEqual({ looping: false, signatures: [] });
  });

  it("rotates an oversized session log while retaining a bounded recent tail", async () => {
    const memory = new SessionMemory({
      logPath,
      maxReplayEntries: 2,
      maxLogBytes: 500,
    });

    await recordIssues(memory, [makeIssue("A", "rule-a", "First fixture issue")]);
    await recordIssues(memory, [makeIssue("B", "rule-b", "Second fixture issue")]);
    await recordIssues(memory, [makeIssue("C", "rule-c", "Third fixture issue")]);

    const currentLines = (await readFile(logPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const rotatedLines = (await readFile(rotatedLogPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    expect(currentLines).toHaveLength(2);
    expect(rotatedLines).toHaveLength(2);
    expect(new SessionMemory({
      logPath,
      maxReplayEntries: 2,
      maxLogBytes: 500,
    }).getStatus()).toEqual({ looping: false, signatures: [] });
  });
});

async function recordIssues(
  memory: SessionMemory,
  issues: readonly NormalizedIssue[],
): Promise<CheckResponse> {
  return memory.recordCheck(
    issues,
    {
      schemaVersion: "1.1",
      status: issues.length === 0 ? "clean" : "issues_found",
      engines: createSuccessfulEngineStatuses(),
      totalIssues: issues.length,
      clusters: [],
      truncated: false,
      loopWarning: null,
    },
  );
}

async function connectClient(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "signalint-phase-4-test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function callCheckFiles(client: Client): Promise<CheckResponse> {
  const result = await client.callTool({
    name: "check_files",
    arguments: { files: ["test/fixtures/sample-project/src/clean.ts"] },
  });
  const parsed = parseTextContent(result.content);
  if (!isCheckResponse(parsed)) {
    throw new Error("check_files did not return a Check Response.");
  }
  return parsed;
}

async function callLoopStatus(client: Client): Promise<LoopStatus> {
  const result = await client.callTool({ name: "get_loop_status", arguments: {} });
  const parsed = parseTextContent(result.content);
  if (!isLoopStatus(parsed)) {
    throw new Error("get_loop_status did not return a Loop Status.");
  }
  return parsed;
}

function parseTextContent(content: unknown): unknown {
  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0].text !== "string") {
    throw new Error("MCP tool did not return text content.");
  }
  return JSON.parse(content[0].text) as unknown;
}

function makeIssue(issueId: string, rule: string, message: string): NormalizedIssue {
  return {
    issueId,
    file: "src/example.ts",
    line: 1,
    col: 1,
    engine: "oxlint",
    rule,
    severity: "error",
    message,
    fixable: false,
  };
}

function createReplayLine(timestamp: number, activeSignatures: readonly string[]): string {
  return JSON.stringify({ timestamp, activeSignatures });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
