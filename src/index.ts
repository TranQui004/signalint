import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Creates the Signalint MCP server with its currently available tools. */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "signalint",
    version: "0.1.0",
  });

  server.registerTool(
    "ping",
    {
      description: "Checks whether the Signalint MCP server is responsive.",
    },
    () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: "pong" }],
      }),
  );

  return server;
}

/** Starts Signalint over stdio and assumes stdin/stdout are owned by an MCP client. */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

await startServer();
