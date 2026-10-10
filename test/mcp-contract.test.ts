import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { createServer, dispatchToolCall } from "../src/server/createServer.js";
import { createTools } from "../src/server/tools.js";
import {
  afterEditCheckOutputSchema,
  checkOutputSchema,
  clusterOutputSchema,
  compareDiagnosticsOutputSchema,
  diagnosticDeltaOutputSchema,
  getDiagnosticSnapshotOutputSchema,
  getIssueDetailOutputSchema,
  getLiveDiagnosticsOutputSchema,
  getLoopStatusOutputSchema,
  ingestDiagnosticsOutputSchema,
  normalizedIssueOutputSchema,
  pingOutputSchema,
  previewDiagnosticFixOutputSchema,
  applyDiagnosticFixOutputSchema,
  discardDiagnosticFixOutputSchema,
  remainingIssueOutputSchema,
} from "../src/server/toolSchemas.js";
import { SessionMemory } from "../src/memory/sessionMemory.js";
import { SnapshotStore } from "../src/diagnostics/snapshots.js";
import { resolveSignalintVersion } from "../src/version.js";

const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(servers.map((s) => s.close()));
  clients.length = 0;
  servers.length = 0;
});

describe("MCP protocol contract and schema verification", () => {
  it("enforces version alignment across runtime and static metadata", async () => {
    const pkgPath = resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    const runtimeVersion = resolveSignalintVersion();

    expect(runtimeVersion).toBe(pkg.version);

    // server.json
    const serverJsonPath = resolve(process.cwd(), "server.json");
    const serverJson = JSON.parse(readFileSync(serverJsonPath, "utf8")) as {
      version: string;
      packages: Array<{ version: string }>;
    };
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages[0]?.version).toBe(pkg.version);

    // action.yml default input
    const actionYmlPath = resolve(process.cwd(), "action.yml");
    const actionYmlContent = readFileSync(actionYmlPath, "utf8");
    const match = actionYmlContent.match(/version:[\s\S]*?default:\s*["']?([^"'\s]+)["']?/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe(pkg.version);

    // MCP initialization serverInfo
    const server = createServer();
    servers.push(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(clientTransport);

    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });

  it("ensures all tools declare valid inputSchema and outputSchema with additionalProperties: false", () => {
    const declaredTools = createTools("both");
    expect(declaredTools.length).toBeGreaterThanOrEqual(5);

    function assertNoAdditionalProperties(schema: unknown, path: string) {
      if (typeof schema !== "object" || schema === null) {
        return;
      }
      const record = schema as Record<string, unknown>;
      if (record.type === "object") {
        expect(
          record.additionalProperties,
          `Schema at ${path} with type 'object' must declare additionalProperties: false`,
        ).toBe(false);
      }
      if (typeof record.properties === "object" && record.properties !== null) {
        for (const [key, propSchema] of Object.entries(record.properties)) {
          assertNoAdditionalProperties(propSchema, `${path}.properties.${key}`);
        }
      }
      if (Array.isArray(record.oneOf)) {
        record.oneOf.forEach((sub, i) => assertNoAdditionalProperties(sub, `${path}.oneOf[${i}]`));
      }
      if (Array.isArray(record.anyOf)) {
        record.anyOf.forEach((sub, i) => assertNoAdditionalProperties(sub, `${path}.anyOf[${i}]`));
      }
      if (typeof record.items === "object" && record.items !== null) {
        assertNoAdditionalProperties(record.items, `${path}.items`);
      }
    }

    for (const tool of declaredTools) {
      expect(tool.name).toBeDefined();
      expect(typeof tool.name).toBe("string");
      expect(tool.description).toBeDefined();

      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      assertNoAdditionalProperties(tool.inputSchema, `${tool.name}.inputSchema`);

      expect(tool.outputSchema).toBeDefined();
      expect(tool.outputSchema?.type).toBe("object");
      assertNoAdditionalProperties(tool.outputSchema, `${tool.name}.outputSchema`);
    }
  });

  it("validates all variant response shapes against declared tool output schemas", () => {
    // 1. checkOutputSchema variants
    const cleanVariant = {
      schemaVersion: "1.4",
      status: "clean",
      projectRoot: "/workspace",
      engines: {
        oxlint: { status: "ok" },
        tsc: { status: "ok" },
        biome: { status: "disabled" },
        eslint: { status: "disabled" },
      },
      totalIssues: 0,
      clusters: [],
      remainingIssues: [],
      omittedIssueCount: 0,
      truncated: false,
    };
    assertMatchesSchemaProperties(cleanVariant, checkOutputSchema);

    const issuesFoundVariant = {
      schemaVersion: "1.4",
      status: "issues_found",
      projectRoot: "/workspace",
      engines: {
        oxlint: { status: "ok" },
        tsc: { status: "ok" },
      },
      totalIssues: 1,
      clusters: [
        {
          clusterId: "c1",
          rootCauseSummary: "Summary",
          ruleIds: ["rule-1"],
          issueCount: 1,
          fileCount: 1,
          priority: 1,
        },
      ],
      remainingIssues: [
        {
          issueId: "i1",
          file: "src/index.ts",
          line: 1,
          col: 1,
          rule: "rule-1",
          severity: "error",
          fixable: false,
          priority: 1,
        },
      ],
      omittedIssueCount: 0,
      truncated: false,
      loopWarning: {
        signature: "sig",
        occurrences: 2,
        hint: "hint",
      },
      fileRuleChurnWarning: null,
    };
    assertMatchesSchemaProperties(issuesFoundVariant, checkOutputSchema);

    const errorVariant = {
      status: "error",
      code: "engine_output_exceeded",
      engine: "tsc",
      message: "tsc exceeded limit",
    };
    assertMatchesSchemaProperties(errorVariant, checkOutputSchema);

    const staleVariant = {
      status: "stale",
      message: "Stale reference",
    };
    assertMatchesSchemaProperties(staleVariant, checkOutputSchema);

    // 2. getIssueDetailOutputSchema variants
    const detailIssuesVariant = {
      issues: [
        {
          issueId: "i1",
          file: "src/index.ts",
          line: 1,
          col: 1,
          engine: "oxlint",
          rule: "rule-1",
          severity: "warning",
          message: "A diagnostic message",
          fixable: false,
        },
      ],
    };
    assertMatchesSchemaProperties(detailIssuesVariant, getIssueDetailOutputSchema);

    const detailStaleVariant = {
      status: "stale",
      message: "This cluster/issue no longer exists; run check_project again.",
    };
    assertMatchesSchemaProperties(detailStaleVariant, getIssueDetailOutputSchema);

    const detailErrorVariant = {
      status: "error",
      code: "invalid_arguments",
      message: "clusterId missing",
      projectRoot: "/workspace",
    };
    assertMatchesSchemaProperties(detailErrorVariant, getIssueDetailOutputSchema);

    // 3. getLoopStatusOutputSchema
    const loopStatusVariant = {
      looping: false,
      signatures: [],
      fileChurning: false,
      fileRuleChurns: [],
    };
    assertMatchesSchemaProperties(loopStatusVariant, getLoopStatusOutputSchema);

    // 4. pingOutputSchema
    const pingVariant = {
      pong: true,
      projectRoot: "/workspace",
    };
    assertMatchesSchemaProperties(pingVariant, pingOutputSchema);

    // 5. getDiagnosticSnapshotOutputSchema
    const snapshotVariant = {
      checkId: "chk-1",
      projectRoot: "/workspace",
      timestamp: Date.now(),
      status: "clean",
      clusters: [],
      remainingIssues: [],
      totalIssues: 0,
      omittedIssueCount: 0,
      engines: { oxlint: { status: "ok" } },
      cache: { hits: 0, misses: 0 },
      source: "project",
      durationMs: 12.3,
    };
    assertMatchesSchemaProperties(snapshotVariant, getDiagnosticSnapshotOutputSchema);

    // 6. compareDiagnosticsOutputSchema
    const compareVariant = {
      status: "ok",
      baselineId: "base-1",
      currentId: "curr-1",
      errorsIntroduced: 0,
      errorsResolved: 1,
      netDelta: -1,
      introducedIssues: [],
      resolvedIssues: [],
      unchangedIssues: [],
      nextStep: "All baseline errors resolved.",
    };
    assertMatchesSchemaProperties(compareVariant, compareDiagnosticsOutputSchema);

    // 7. afterEditCheckOutputSchema
    const afterEditVariant = {
      schemaVersion: "1.4",
      status: "clean",
      projectRoot: "/workspace",
      engines: { oxlint: { status: "ok" } },
      totalIssues: 0,
      clusters: [],
      remainingIssues: [],
      omittedIssueCount: 0,
      truncated: false,
      delta: compareVariant,
    };
    assertMatchesSchemaProperties(afterEditVariant, afterEditCheckOutputSchema);

    // 8. ingestDiagnosticsOutputSchema
    const ingestVariant = {
      snapshotId: "snap-1",
      checkId: "snap-1",
      totalIssues: 0,
      clusters: [],
      remainingIssues: [],
    };
    assertMatchesSchemaProperties(ingestVariant, ingestDiagnosticsOutputSchema);

    // 9. getLiveDiagnosticsOutputSchema
    const liveVariant = {
      status: "clean",
      totalIssues: 0,
      clusters: [],
      remainingIssues: [],
      issues: [],
    };
    assertMatchesSchemaProperties(liveVariant, getLiveDiagnosticsOutputSchema);

    // 10. previewDiagnosticFixOutputSchema variants
    const previewVariant = {
      transactionId: "tx_123",
      filesCount: 1,
      summary: "Prepared 1 patch",
      patchesPreview: [
        {
          file: "src/index.ts",
          originalLength: 10,
          patchedLength: 15,
        },
      ],
      status: "prepared",
    };
    assertMatchesSchemaProperties(previewVariant, previewDiagnosticFixOutputSchema);

    // 11. applyDiagnosticFixOutputSchema variants
    const applyVariant = {
      transactionId: "tx_123",
      status: "success",
      filesModified: ["src/index.ts"],
      postCheckId: "check_123",
    };
    assertMatchesSchemaProperties(applyVariant, applyDiagnosticFixOutputSchema);

    // 12. discardDiagnosticFixOutputSchema variants
    const discardVariant = {
      transactionId: "tx_123",
      discarded: true,
    };
    assertMatchesSchemaProperties(discardVariant, discardDiagnosticFixOutputSchema);

    // 13. additionalProperties: false checks
    expect(normalizedIssueOutputSchema.additionalProperties).toBe(false);
    expect(clusterOutputSchema.additionalProperties).toBe(false);
    expect(remainingIssueOutputSchema.additionalProperties).toBe(false);
    expect(getDiagnosticSnapshotOutputSchema.additionalProperties).toBe(false);
    expect(compareDiagnosticsOutputSchema.additionalProperties).toBe(false);
    expect(afterEditCheckOutputSchema.additionalProperties).toBe(false);
    expect(diagnosticDeltaOutputSchema.additionalProperties).toBe(false);
    expect(ingestDiagnosticsOutputSchema.additionalProperties).toBe(false);
    expect(getLiveDiagnosticsOutputSchema.additionalProperties).toBe(false);
    expect(previewDiagnosticFixOutputSchema.additionalProperties).toBe(false);
    expect(applyDiagnosticFixOutputSchema.additionalProperties).toBe(false);
    expect(discardDiagnosticFixOutputSchema.additionalProperties).toBe(false);
  });

  it("handles outputSchema declaration across payload modes: both, structured, and text", () => {
    const bothTools = createTools("both");
    const structuredTools = createTools("structured");
    const textTools = createTools("text");

    expect(bothTools.length).toBe(13);
    expect(structuredTools.length).toBe(13);
    expect(textTools.length).toBe(13);

    for (const tool of bothTools) {
      expect(tool.outputSchema).toBeDefined();
    }
    for (const tool of structuredTools) {
      expect(tool.outputSchema).toBeDefined();
    }
    for (const tool of textTools) {
      expect(tool.outputSchema).toBeUndefined();
    }
  });

  it("throws protocol InvalidParams McpError for unknown tool name", async () => {
    const server = createServer();
    servers.push(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "protocol-error-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(clientTransport);

    await expect(
      client.callTool({ name: "non_existent_unknown_tool", arguments: {} }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(McpError);
      const mcpError = error as McpError;
      expect(mcpError.code).toBe(ErrorCode.InvalidParams);
      expect(mcpError.message).toContain("Unknown tool: non_existent_unknown_tool");
      return true;
    });
  });

  it("throws protocol InvalidParams McpError when tool arguments violate RPC structure", async () => {
    const dummyProvider = () =>
      Promise.resolve({ issues: [], cache: { hits: 0, misses: 0 }, engines: {} });
    const context = {
      cwd: process.cwd(),
      fileIssueProvider: dummyProvider,
      projectIssueProvider: dummyProvider,
      sessionMemory: new SessionMemory(),
      payloadMode: "both" as const,
      snapshotStore: new SnapshotStore(),
    };

    await expect(
      dispatchToolCall("ping", "not-an-object", new AbortController().signal, context),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(McpError);
      const mcpError = error as McpError;
      expect(mcpError.code).toBe(ErrorCode.InvalidParams);
      expect(mcpError.message).toContain("Malformed tool arguments");
      return true;
    });
  });

  it("rejects get_issue_detail calls when checkId is missing", async () => {
    const server = createServer();
    servers.push(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "schema-rejection-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_issue_detail",
      arguments: { clusterId: "c1" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as { status: string; code: string; message: string };
    expect(parsed.status).toBe("error");
    expect(parsed.code).toBe("invalid_arguments");
  });
});

function assertMatchesSchemaProperties(value: Record<string, unknown>, schema: Record<string, unknown>) {
  const allowedProps = schema.properties ? Object.keys(schema.properties as Record<string, unknown>) : [];
  for (const key of Object.keys(value)) {
    expect(
      allowedProps,
      `Property '${key}' was not declared in schema properties: ${allowedProps.join(", ")}`,
    ).toContain(key);
  }
}
