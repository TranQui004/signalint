import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
});

describe("Phase 5 acceptance", () => {
  it("verifies compiled entrypoints dist/src/index.js and dist/src/cli.js exist", () => {
    const indexPath = resolve("dist/src/index.js");
    const cliPath = resolve("dist/src/cli.js");

    expect(existsSync(indexPath)).toBe(true);
    expect(existsSync(cliPath)).toBe(true);
  });

  it("spawns node dist/src/index.js over stdio and responds to ping", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/src/index.js")],
    });
    const client = new Client({
      name: "signalint-phase-5-acceptance",
      version: "1.0.0",
    });
    clients.push(client);

    await client.connect(transport);
    const result = await client.callTool({
      name: "ping",
      arguments: {},
    });

    expect(result.structuredContent).toEqual({
      pong: true,
      projectRoot: expect.any(String),
    });
  });
});
