import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createServer } from "../src/index.js";
import { SessionMemory } from "../src/memory/sessionMemory.js";
import { MAX_TOOL_PATHS } from "../src/projectPaths.js";
import type { NormalizedIssue } from "../src/schema.js";

interface StructuredRefusal {
  status: "error";
  code: string;
  message: string;
}

const securityRoot = resolve(".signalint/test/security");
const projectRoot = resolve(securityRoot, "project");
const outsideRoot = resolve(securityRoot, "outside");
const clients: Client[] = [];
const servers: Server[] = [];

beforeAll(async () => {
  await rm(securityRoot, { force: true, recursive: true });
  await mkdir(resolve(projectRoot, "src"), { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(resolve(projectRoot, "src/safe.ts"), "export const safe = true;\n", "utf8");
  await writeFile(resolve(outsideRoot, "secret.ts"), "export const secret = true;\n", "utf8");
  await symlink(
    outsideRoot,
    resolve(projectRoot, "escape"),
    process.platform === "win32" ? "junction" : "dir",
  );
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(servers.map((server) => server.close()));
  clients.length = 0;
  servers.length = 0;
});

afterAll(async () => {
  await rm(securityRoot, { force: true, recursive: true });
});

describe("MCP tool security boundary", () => {
  it("refuses traversal in check_files and check_project without invoking providers", async () => {
    const connection = await connectSecurityServer();

    for (const [name, argumentsValue] of [
      ["check_files", { files: ["../outside/secret.ts"] }],
      ["check_project", { paths: ["../outside"] }],
    ] as const) {
      const refusal = await callForRefusal(connection.client, name, argumentsValue);
      expect(refusal).toMatchObject({
        status: "error",
        code: "path_outside_project",
      });
    }

    expect(connection.fileProvider).not.toHaveBeenCalled();
    expect(connection.projectProvider).not.toHaveBeenCalled();
  });

  it("refuses absolute, NUL-containing, and leading-dash paths", async () => {
    const connection = await connectSecurityServer();
    const cases = [
      {
        name: "check_project",
        argumentsValue: { paths: [resolve(projectRoot, "src/safe.ts")] },
        code: "path_outside_project",
      },
      {
        name: "check_files",
        argumentsValue: { files: ["src/\0unsafe.ts"] },
        code: "invalid_path",
      },
      {
        name: "check_files",
        argumentsValue: { files: ["--version"] },
        code: "invalid_path",
      },
    ] as const;

    for (const testCase of cases) {
      const refusal = await callForRefusal(
        connection.client,
        testCase.name,
        testCase.argumentsValue,
      );
      expect(refusal.code).toBe(testCase.code);
    }

    expect(connection.fileProvider).not.toHaveBeenCalled();
    expect(connection.projectProvider).not.toHaveBeenCalled();
  });

  it("canonicalizes symlinks and refuses targets outside the project root", async () => {
    const connection = await connectSecurityServer();

    const refusal = await callForRefusal(connection.client, "check_files", {
      files: ["escape/secret.ts"],
    });

    expect(refusal).toMatchObject({
      status: "error",
      code: "path_outside_project",
    });
    expect(connection.fileProvider).not.toHaveBeenCalled();
  });

  it("strictly rejects non-arrays, non-string elements, and oversized arrays", async () => {
    const connection = await connectSecurityServer();
    const cases: readonly Record<string, unknown>[] = [
      { files: "src/safe.ts" },
      { files: ["src/safe.ts", 7] },
      { files: Array.from({ length: MAX_TOOL_PATHS + 1 }, () => "src/safe.ts") },
    ];

    for (const argumentsValue of cases) {
      const refusal = await callForRefusal(connection.client, "check_files", argumentsValue);
      expect(refusal).toMatchObject({
        status: "error",
        code: "invalid_arguments",
      });
    }

    expect(connection.fileProvider).not.toHaveBeenCalled();
  });

  it("enforces strict runtime schemas for ping, issue detail, and loop status", async () => {
    const connection = await connectSecurityServer();
    const cases = [
      ["ping", { unexpected: true }],
      ["get_issue_detail", { clusterId: "c1", issueId: "i1" }],
      ["get_issue_detail", {}],
      ["get_loop_status", { unexpected: true }],
    ] as const;

    for (const [name, argumentsValue] of cases) {
      const refusal = await callForRefusal(connection.client, name, argumentsValue);
      expect(refusal).toMatchObject({
        status: "error",
        code: "invalid_arguments",
      });
    }
  });

  it("passes canonical project-relative paths to providers after validation", async () => {
    const connection = await connectSecurityServer();

    const result = await connection.client.callTool({
      name: "check_files",
      arguments: { files: ["src/../src/safe.ts"] },
    });

    expect(result.isError).not.toBe(true);
    expect(connection.fileProvider).toHaveBeenCalledWith(
      ["src/safe.ts"],
      expect.any(AbortSignal),
    );
  });

  it("refuses traversal through the compiled stdio MCP entrypoint", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/src/index.js")],
      cwd: projectRoot,
      stderr: "pipe",
    });
    const client = new Client({ name: "signalint-security-stdio-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const refusal = await callForRefusal(client, "check_files", {
      files: ["../outside/secret.ts"],
    });

    expect(refusal).toMatchObject({
      status: "error",
      code: "path_outside_project",
    });
  });
});

async function connectSecurityServer(): Promise<{
  client: Client;
  fileProvider: ReturnType<typeof vi.fn<() => Promise<NormalizedIssue[]>>>;
  projectProvider: ReturnType<typeof vi.fn<() => Promise<NormalizedIssue[]>>>;
}> {
  const fileProvider = vi.fn(() => Promise.resolve<NormalizedIssue[]>([]));
  const projectProvider = vi.fn(() => Promise.resolve<NormalizedIssue[]>([]));
  const server = createServer({
    cwd: projectRoot,
    fileIssueProvider: fileProvider,
    projectIssueProvider: projectProvider,
    sessionMemory: new SessionMemory({ logPath: resolve(securityRoot, "session.jsonl") }),
  });
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "signalint-security-test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return { client, fileProvider, projectProvider };
}

async function callForRefusal(
  client: Client,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<StructuredRefusal> {
  const result = await client.callTool({ name, arguments: argumentsValue });
  expect(result.isError).toBe(true);
  const parsed = parseTextContent(result.content);
  if (!isStructuredRefusal(parsed)) {
    throw new Error("MCP tool did not return a structured refusal.");
  }
  return parsed;
}

function parseTextContent(content: unknown): unknown {
  if (!Array.isArray(content) || !isRecord(content[0]) || typeof content[0].text !== "string") {
    throw new Error("MCP tool did not return text content.");
  }
  return JSON.parse(content[0].text) as unknown;
}

function isStructuredRefusal(value: unknown): value is StructuredRefusal {
  return (
    isRecord(value) &&
    value.status === "error" &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
