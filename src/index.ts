#!/usr/bin/env node

import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { runBiome } from "./adapters/biome.js";
import { runOxlint } from "./adapters/oxlint.js";
import { runTsc } from "./adapters/tsc.js";
import {
  checkFilesWithStats,
  type CacheStats,
  type CheckFilesResult,
} from "./checkFiles.js";
import { clusterIssues } from "./cluster/clusterEngine.js";
import {
  filterIgnoredPaths,
  isIgnoredPath,
  loadSignalintConfig,
} from "./config.js";
import { filterDefaultExcludedIssues } from "./defaultExclusions.js";
import { SessionMemory } from "./memory/sessionMemory.js";
import type { CheckResponse, NormalizedIssue } from "./schema.js";

export interface SignalintServerOptions {
  fileIssueProvider?: (files: readonly string[]) => Promise<NormalizedIssue[]>;
  projectIssueProvider?: (paths: readonly string[]) => Promise<NormalizedIssue[]>;
  sessionMemory?: SessionMemory;
}

interface IssueProviderResult {
  issues: NormalizedIssue[];
  cache: CacheStats;
}

type IssueProvider = (paths: readonly string[]) => Promise<IssueProviderResult>;

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
    description: "Runs and clusters Oxlint and TypeScript diagnostics for project paths.",
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
  {
    name: "check_files",
    description: "Checks changed files with per-engine content and configuration caching.",
    inputSchema: {
      type: "object" as const,
      properties: {
        files: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
  },
  {
    name: "get_loop_status",
    description: "Returns diagnostic signatures that are looping in this server session.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
    },
  },
];

/** Creates the Signalint MCP server with process-lifetime loop memory and optional test providers. */
export function createServer(options: SignalintServerOptions = {}): Server {
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

  const sessionMemory = options.sessionMemory ?? new SessionMemory();
  const projectIssueProvider = wrapIssueProvider(
    options.projectIssueProvider ?? collectProjectIssues,
  );
  const fileIssueProvider = options.fileIssueProvider === undefined
    ? (files: readonly string[]) => checkConfiguredFilesWithStats(files)
    : wrapIssueProvider(options.fileIssueProvider);
  registerToolHandlers(server, sessionMemory, projectIssueProvider, fileIssueProvider);
  return server;
}

/** Starts Signalint over stdio and assumes stdin/stdout are owned by an MCP client. */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Runs configured adapters and returns the compact clustered project response. */
export async function checkProject(
  paths: readonly string[],
  cwd: string = process.cwd(),
): Promise<CheckResponse> {
  return clusterIssues(await collectProjectIssues(paths, cwd)).response;
}

/** Runs enabled project adapters and excludes diagnostics matching configured ignore globs. */
export async function collectProjectIssues(
  paths: readonly string[],
  cwd: string = process.cwd(),
): Promise<NormalizedIssue[]> {
  const config = await loadSignalintConfig(cwd);
  const includedPaths = filterIgnoredPaths(paths, config.ignore);
  if (includedPaths.length === 0) {
    return [];
  }

  const results = await Promise.all([
    config.engines.oxlint ? runOxlint(includedPaths, { cwd }) : Promise.resolve([]),
    config.engines.tsc ? runTsc(includedPaths, { cwd }) : Promise.resolve([]),
    config.engines.biome ? runBiome(includedPaths, { cwd }) : Promise.resolve([]),
  ]);
  return filterDefaultExcludedIssues(results.flat())
    .filter((issue) => !isIgnoredPath(issue.file, config.ignore))
    .sort(compareIssues);
}

/** Runs enabled incremental adapters and excludes requested or returned ignored paths. */
export async function checkConfiguredFiles(
  files: readonly string[],
  cwd: string = process.cwd(),
): Promise<NormalizedIssue[]> {
  return (await checkConfiguredFilesWithStats(files, cwd)).issues;
}

/** Runs enabled incremental adapters and returns issues plus cache metrics for session logging. */
export async function checkConfiguredFilesWithStats(
  files: readonly string[],
  cwd: string = process.cwd(),
): Promise<CheckFilesResult> {
  const config = await loadSignalintConfig(cwd);
  const includedFiles = filterIgnoredPaths(files, config.ignore);
  if (includedFiles.length === 0) {
    return { issues: [], cache: { hits: 0, misses: 0 } };
  }
  const result = await checkFilesWithStats(includedFiles, {
    cwd,
    engines: config.engines,
  });
  return {
    issues: filterDefaultExcludedIssues(result.issues)
      .filter((issue) => !isIgnoredPath(issue.file, config.ignore)),
    cache: result.cache,
  };
}

/** Registers all available MCP tool handlers on a configured server and session memory. */
function registerToolHandlers(
  server: Server,
  sessionMemory: SessionMemory,
  projectIssueProvider: IssueProvider,
  fileIssueProvider: IssueProvider,
): void {
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    if (request.params.name === "ping") {
      return { content: [{ type: "text", text: "pong" }] };
    }
    if (request.params.name === "check_project") {
      const startedAt = performance.now();
      const paths = readStringArray(request.params.arguments, "paths", ["."]);
      const result = await projectIssueProvider(paths);
      const clustered = clusterIssues(filterDefaultExcludedIssues(result.issues));
      const response = await sessionMemory.recordCheck(
        clustered.issues,
        clustered.response,
        result.cache,
        startedAt,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
    if (request.params.name === "check_files") {
      const startedAt = performance.now();
      const files = readStringArray(request.params.arguments, "files");
      const result = await fileIssueProvider(files);
      const clustered = clusterIssues(filterDefaultExcludedIssues(result.issues));
      const response = await sessionMemory.recordCheck(
        clustered.issues,
        clustered.response,
        result.cache,
        startedAt,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
      };
    }
    if (request.params.name === "get_loop_status") {
      return {
        content: [{ type: "text", text: JSON.stringify(sessionMemory.getStatus(), null, 2) }],
      };
    }
    return {
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      isError: true,
    };
  });
}

function wrapIssueProvider(
  provider: (paths: readonly string[]) => Promise<NormalizedIssue[]>,
): IssueProvider {
  return async (paths) => ({
    issues: await provider(paths),
    cache: { hits: 0, misses: 0 },
  });
}

function readStringArray(
  argumentsValue: Record<string, unknown> | undefined,
  key: string,
  defaultValue?: readonly string[],
): string[] {
  const value = argumentsValue?.[key];
  if (value === undefined && defaultValue !== undefined) {
    return [...defaultValue];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value;
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
