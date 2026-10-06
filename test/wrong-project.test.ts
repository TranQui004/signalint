import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

import { clusterIssues } from "../src/cluster/clusterEngine.js";
import { checkProject } from "../src/index.js";
import { isCheckResponse } from "../src/schema.js";

const clients: Client[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("Phase 0 acceptance tests (wrong project and safety nets)", () => {
  it("1. clusterIssues with an error engine returns status error", () => {
    const result = clusterIssues([], 10, {
      oxlint: { status: "error", message: "oxlint crashed" },
      tsc: { status: "ok" },
      biome: { status: "disabled" },
      eslint: { status: "disabled" },
    });

    expect(result.response.status).toBe("error");
    expect(result.response.code).toBe("engine_failed");
    expect(result.response.message).toContain("oxlint");
  });

  it("2. Zero included paths returns status error, code nothing_checked, every engine disabled", async () => {
    const projectRoot = realpathSync(resolve("test/fixtures/fresh-install-project"));
    const response = await checkProject([], projectRoot);

    expect(response.status).toBe("error");
    expect(response.code).toBe("nothing_checked");
    expect(response.message).toBe("No paths were checked; nothing can be reported clean.");
    expect(response.engines.oxlint.status).toBe("disabled");
    expect(response.engines.tsc.status).toBe("disabled");
    expect(response.engines.biome.status).toBe("disabled");
    expect(response.engines.eslint.status).toBe("disabled");
  });

  it("3. Stdio integration: server started with cwd = fixtureProjectA returns projectRoot === realpath(fixtureProjectA)", async () => {
    const fixtureProjectA = realpathSync(resolve("test/fixtures/fresh-install-project"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/src/index.js")],
      cwd: fixtureProjectA,
    });
    const client = new Client({ name: "test-wrong-project-3", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.callTool({
      name: "check_project",
      arguments: {},
    });
    const response = parseToolResponse(result.content);
    expect(response.projectRoot).toBe(fixtureProjectA);
  });

  it("4. Stdio integration: server started in a temp dir WITHOUT signalint.config.json returns code project_not_initialized", async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "signalint-uninit-"));
    tempDirs.push(tempDir);
    await writeFile(resolve(tempDir, "index.ts"), "export const a: number = 1;\n", "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/src/index.js")],
      cwd: tempDir,
    });
    const client = new Client({ name: "test-wrong-project-4", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.callTool({
      name: "check_project",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const response = parseToolResponse(result.content);
    expect(response.status).toBe("error");
    expect(response.code).toBe("project_not_initialized");
    expect(response.message).toContain("npx signalint-mcp init");
  });

  it("5. Same as 4 with SIGNALINT_ALLOW_UNINITIALIZED=1 behaves as today", async () => {
    const tempDir = await mkdtemp(resolve(tmpdir(), "signalint-allow-uninit-"));
    tempDirs.push(tempDir);
    await writeFile(resolve(tempDir, "index.ts"), "export const a: number = 1;\n", "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/src/index.js")],
      cwd: tempDir,
      env: {
        ...process.env,
        SIGNALINT_ALLOW_UNINITIALIZED: "1",
      },
    });
    const client = new Client({ name: "test-wrong-project-5", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const result = await client.callTool({
      name: "check_project",
      arguments: {},
    });
    const response = parseToolResponse(result.content);
    expect(response.code).not.toBe("project_not_initialized");
    expect(isCheckResponse(response)).toBe(true);
  });

  it("6. SIGNALINT_PROJECT_ROOT=<A> while process runs in <B> returns projectRoot === A", async () => {
    const targetProjectA = realpathSync(resolve("test/fixtures/fresh-install-project"));
    const otherDirB = realpathSync(resolve("test/fixtures/config-project"));

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/src/index.js")],
      cwd: otherDirB,
      env: {
        ...process.env,
        SIGNALINT_PROJECT_ROOT: targetProjectA,
      },
    });
    const client = new Client({ name: "test-wrong-project-6", version: "1.0.0" });
    clients.push(client);
    await client.connect(transport);

    const pingResult = await client.callTool({
      name: "ping",
      arguments: {},
    });
    expect((pingResult.structuredContent as Record<string, unknown> | undefined)?.projectRoot).toBe(targetProjectA);

    const checkResult = await client.callTool({
      name: "check_project",
      arguments: {},
    });
    const response = parseToolResponse(checkResult.content);
    expect(response.projectRoot).toBe(targetProjectA);
  });
});

function parseToolResponse(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content) || !content[0] || typeof content[0].text !== "string") {
    throw new Error("Expected text tool content.");
  }
  return JSON.parse(content[0].text) as Record<string, unknown>;
}
