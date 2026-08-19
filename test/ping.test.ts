import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
});

describe("Phase 0 MCP smoke test", () => {
  it("connects over stdio and returns pong from the ping tool", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/src/index.js")],
    });
    const client = new Client({
      name: "signalint-phase-0-smoke",
      version: "1.0.0",
    });
    clients.push(client);

    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({
      name: "ping",
      arguments: {},
    });

    expect(tools.tools.map((tool) => tool.name)).toContain("ping");
    const pingTool = tools.tools.find((t) => t.name === "ping");
    expect(pingTool?.outputSchema).toBeDefined();
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    expect(result.structuredContent).toEqual({ pong: true });
  });
});
