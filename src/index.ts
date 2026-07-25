import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { runOxlint } from "./adapters/oxlint.js";
import { runTsc } from "./adapters/tsc.js";
import type { NormalizedIssue } from "./schema.js";

const tools = [
  {
    name: "ping",
    description: "Checks whether the Signalint MCP server is responsive.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
    },
  },
  {
    name: "check_project",
    description: "Runs raw, unclustered Oxlint and TypeScript diagnostics for project paths.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paths: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      additionalProperties: false,
    },
  },
];

/** Creates the Signalint MCP server and assumes engine paths resolve from this package. */
export function createServer(): Server {
  const server = new Server(
    {
      name: "signalint",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerToolHandlers(server);
  return server;
}

/** Starts Signalint over stdio and assumes stdin/stdout are owned by an MCP client. */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Runs both Phase 1 adapters and returns raw issues without cluster fields. */
export async function checkProject(
  paths: readonly string[],
  cwd: string = process.cwd(),
): Promise<NormalizedIssue[]> {
  const [oxlintIssues, tscIssues] = await Promise.all([
    runOxlint(paths, { cwd }),
    runTsc(paths, { cwd }),
  ]);
  return [...oxlintIssues, ...tscIssues].sort(compareIssues);
}

/** Registers the Phase 0 and Phase 1 MCP tool handlers on a configured server. */
function registerToolHandlers(server: Server): void {
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    if (request.params.name === "ping") {
      return { content: [{ type: "text", text: "pong" }] };
    }
    if (request.params.name === "check_project") {
      const paths = readPaths(request.params.arguments);
      const issues = await checkProject(paths);
      return {
        content: [{ type: "text", text: JSON.stringify(issues, null, 2) }],
      };
    }
    return {
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  });
}

function readPaths(argumentsValue: Record<string, unknown> | undefined): string[] {
  if (argumentsValue === undefined || argumentsValue.paths === undefined) {
    return ["."];
  }
  if (
    !Array.isArray(argumentsValue.paths) ||
    !argumentsValue.paths.every((path) => typeof path === "string")
  ) {
    throw new Error("check_project paths must be an array of strings.");
  }
  return argumentsValue.paths.length === 0 ? ["."] : argumentsValue.paths;
}

function compareIssues(left: NormalizedIssue, right: NormalizedIssue): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.col - right.col ||
    left.engine.localeCompare(right.engine)
  );
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  await startServer();
}
