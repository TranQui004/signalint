#!/usr/bin/env node

import { performance } from "node:perf_hooks";

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
import { createLinkedAbortController } from "./abort.js";
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
import { isMainModule } from "./mainModule.js";
import { SessionMemory } from "./memory/sessionMemory.js";
import type {
  CheckResponse,
  NormalizedIssue,
  StaleReferenceResponse,
} from "./schema.js";
import { EngineTimeoutError } from "./subprocess.js";

type RawIssueProvider = (
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<NormalizedIssue[]>;

export interface SignalintServerOptions {
  fileIssueProvider?: RawIssueProvider;
  projectIssueProvider?: RawIssueProvider;
  sessionMemory?: SessionMemory;
}

interface IssueProviderResult {
  issues: NormalizedIssue[];
  cache: CacheStats;
}

type IssueProvider = (
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<IssueProviderResult>;

const STALE_REFERENCE_RESPONSE: StaleReferenceResponse = {
  status: "stale",
  message: "This cluster/issue no longer exists; run check_project again.",
};

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
    name: "get_issue_detail",
    description: "Returns all current issues for one cluster or one current issue ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        clusterId: { type: "string" as const },
        issueId: { type: "string" as const },
      },
      oneOf: [
        { required: ["clusterId"] },
        { required: ["issueId"] },
      ],
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
  const projectIssueProvider = options.projectIssueProvider === undefined
    ? wrapIssueProvider((paths, signal) => collectProjectIssues(paths, process.cwd(), signal))
    : wrapIssueProvider(options.projectIssueProvider);
  const fileIssueProvider = options.fileIssueProvider === undefined
    ? (files: readonly string[], signal?: AbortSignal) =>
        checkConfiguredFilesWithStats(files, process.cwd(), signal)
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
  signal?: AbortSignal,
): Promise<NormalizedIssue[]> {
  const config = await loadSignalintConfig(cwd);
  const includedPaths = filterIgnoredPaths(paths, config.ignore);
  if (includedPaths.length === 0) {
    return [];
  }

  const linkedAbort = createLinkedAbortController(signal);
  try {
    const results = await Promise.all([
      config.engines.oxlint
        ? runOxlint(includedPaths, {
            cwd,
            signal: linkedAbort.controller.signal,
            timeoutMs: config.timeoutsMs.oxlint,
          })
        : Promise.resolve([]),
      config.engines.tsc
        ? runTsc(includedPaths, {
            cwd,
            signal: linkedAbort.controller.signal,
            timeoutMs: config.timeoutsMs.tsc,
          })
        : Promise.resolve([]),
      config.engines.biome
        ? runBiome(includedPaths, {
            cwd,
            signal: linkedAbort.controller.signal,
            timeoutMs: config.timeoutsMs.biome,
          })
        : Promise.resolve([]),
    ]);
    return filterDefaultExcludedIssues(results.flat())
      .filter((issue) => !isIgnoredPath(issue.file, config.ignore))
      .sort(compareIssues);
  } catch (error: unknown) {
    linkedAbort.controller.abort();
    throw error;
  } finally {
    linkedAbort.dispose();
  }
}

/** Runs enabled incremental adapters and excludes requested or returned ignored paths. */
export async function checkConfiguredFiles(
  files: readonly string[],
  cwd: string = process.cwd(),
  signal?: AbortSignal,
): Promise<NormalizedIssue[]> {
  return (await checkConfiguredFilesWithStats(files, cwd, signal)).issues;
}

/** Runs enabled incremental adapters and returns issues plus cache metrics for session logging. */
export async function checkConfiguredFilesWithStats(
  files: readonly string[],
  cwd: string = process.cwd(),
  signal?: AbortSignal,
): Promise<CheckFilesResult> {
  const config = await loadSignalintConfig(cwd);
  const includedFiles = filterIgnoredPaths(files, config.ignore);
  if (includedFiles.length === 0) {
    return { issues: [], cache: { hits: 0, misses: 0 } };
  }
  const result = await checkFilesWithStats(includedFiles, {
    cwd,
    engines: config.engines,
    signal,
    timeoutsMs: config.timeoutsMs,
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
  let latestIssues: NormalizedIssue[] = [];
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    if (request.params.name === "ping") {
      return { content: [{ type: "text", text: "pong" }] };
    }
    if (request.params.name === "check_project") {
      const paths = readStringArray(request.params.arguments, "paths", ["."]);
      return runCheck(
        paths,
        extra.signal,
        projectIssueProvider,
        sessionMemory,
        (issues) => {
          latestIssues = issues;
        },
      );
    }
    if (request.params.name === "check_files") {
      const files = readStringArray(request.params.arguments, "files");
      return runCheck(
        files,
        extra.signal,
        fileIssueProvider,
        sessionMemory,
        (issues) => {
          latestIssues = issues;
        },
      );
    }
    if (request.params.name === "get_issue_detail") {
      return createTextResult(resolveIssueDetail(latestIssues, request.params.arguments));
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
  provider: RawIssueProvider,
): IssueProvider {
  return async (paths, signal) => ({
    issues: await provider(paths, signal),
    cache: { hits: 0, misses: 0 },
  });
}

async function runCheck(
  paths: readonly string[],
  signal: AbortSignal,
  provider: IssueProvider,
  sessionMemory: SessionMemory,
  saveIssues: (issues: NormalizedIssue[]) => void,
): Promise<CallToolResult> {
  const startedAt = performance.now();
  try {
    const result = await provider(paths, signal);
    const clustered = clusterIssues(filterDefaultExcludedIssues(result.issues));
    const response = await sessionMemory.recordCheck(
      clustered.issues,
      clustered.response,
      result.cache,
      startedAt,
    );
    saveIssues(clustered.issues);
    return createTextResult(response);
  } catch (error: unknown) {
    if (error instanceof EngineTimeoutError) {
      return createTextResult(error.response);
    }
    throw error;
  }
}

function resolveIssueDetail(
  issues: readonly NormalizedIssue[],
  argumentsValue: Record<string, unknown> | undefined,
): NormalizedIssue[] | StaleReferenceResponse {
  const reference = readIssueReference(argumentsValue);
  const matches = issues.filter((issue) => issue[reference.key] === reference.value);
  return matches.length === 0 ? STALE_REFERENCE_RESPONSE : matches;
}

function readIssueReference(
  argumentsValue: Record<string, unknown> | undefined,
): { key: "clusterId" | "issueId"; value: string } {
  const clusterId = argumentsValue?.clusterId;
  const issueId = argumentsValue?.issueId;
  if (typeof clusterId === "string" && issueId === undefined) {
    return { key: "clusterId", value: clusterId };
  }
  if (typeof issueId === "string" && clusterId === undefined) {
    return { key: "issueId", value: issueId };
  }
  throw new Error("get_issue_detail requires exactly one clusterId or issueId string.");
}

function createTextResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
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

if (isMainModule(import.meta.url)) {
  await startServer();
}
