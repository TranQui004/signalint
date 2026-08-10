#!/usr/bin/env node

import { performance } from "node:perf_hooks";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import { runBiome } from "./adapters/biome.js";
import { runOxlint } from "./adapters/oxlint.js";
import { runTsc } from "./adapters/tsc.js";
import { createLinkedAbortController } from "./abort.js";
import {
  checkFilesWithStats,
  type CacheStats,
  type CheckFilesResult,
} from "./checkFiles.js";
import { clusterIssues, type ClusterResult } from "./cluster/clusterEngine.js";
import {
  filterIgnoredPaths,
  isIgnoredPath,
  loadSignalintConfig,
} from "./config.js";
import { filterDefaultExcludedIssues } from "./defaultExclusions.js";
import {
  createIdleEngineStatuses,
  settleEngineTasks,
} from "./engineFanout.js";
import {
  closeRuntimeResources,
  registerProcessLifecycle,
  writeFatalError,
} from "./lifecycle.js";
import { runInitCommandSafely } from "./init.js";
import { isMainModule } from "./mainModule.js";
import { SessionMemory } from "./memory/sessionMemory.js";
import {
  MAX_TOOL_PATHS,
  ProjectPathError,
  resolveProjectPaths,
} from "./projectPaths.js";
import type {
  CheckResponse,
  EngineStatuses,
  NormalizedIssue,
  StaleReferenceResponse,
} from "./schema.js";
import {
  EngineOutputLimitError,
  EngineTimeoutError,
  readErrorEngine,
} from "./subprocess.js";
import {
  parseCheckFilesArguments,
  parseCheckProjectArguments,
  parseIssueReference,
  parseLoopStatusArguments,
  parsePingArguments,
  type IssueReference,
} from "./toolArguments.js";

type RawIssueProvider = (
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<NormalizedIssue[]>;

export interface SignalintServerOptions {
  cwd?: string;
  fileIssueProvider?: RawIssueProvider;
  projectIssueProvider?: RawIssueProvider;
  sessionMemory?: SessionMemory;
}

interface IssueProviderResult {
  issues: NormalizedIssue[];
  cache: CacheStats;
  engines: EngineStatuses;
}

type IssueProvider = (
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<IssueProviderResult>;

interface ToolHandlerContext {
  cwd: string;
  fileIssueProvider: IssueProvider;
  latestIssues: NormalizedIssue[];
  projectIssueProvider: IssueProvider;
  sessionMemory: SessionMemory;
}

const STALE_REFERENCE_RESPONSE: StaleReferenceResponse = {
  status: "stale",
  message: "This cluster/issue no longer exists; run check_project again.",
};

const tools = [
  {
    name: "ping",
    description: "Checks whether the Signalint MCP server is responsive. Read-only; returns the string \"pong\" with no side effects. Use this to verify the server is connected before running diagnostics. Invalid arguments return an error response; no authentication is required.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
    },
  },
  {
    name: "check_project",
    description: "Runs and clusters Oxlint and TypeScript (and optionally Biome) lint and type diagnostics for one or more project paths. Read-only; no files are written or modified. Paths default to the project root (\".\") when omitted; paths must be relative and within the project directory — absolute paths or paths outside the root return an error response. Use this for a full project scan; use check_files instead for faster incremental checks after editing specific files. Each call re-runs all enabled engines with no caching.",
    inputSchema: {
      type: "object" as const,
      properties: {
        paths: {
          type: "array" as const,
          items: { type: "string" as const, minLength: 1 },
          maxItems: MAX_TOOL_PATHS,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "check_files",
    description: "Runs Oxlint and TypeScript (and optionally Biome) lint and type diagnostics on a specific list of files, using per-engine content-hash caching to skip unchanged files. Read-only; no files are written or modified. Use this for incremental checks after editing specific files; use check_project for a full project scan. The files parameter expects relative file paths (not glob patterns) within the project directory — absolute paths or paths outside the root return an error response. Caching is file-content-hash-based: a file is re-checked only when its content or the engine's config file (e.g., .oxlintrc, tsconfig.json) has changed since the last call, not based on git status. TypeScript is a whole-program engine: it re-runs whenever any TypeScript file in the request has changed content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        files: {
          type: "array" as const,
          items: { type: "string" as const, minLength: 1 },
          maxItems: MAX_TOOL_PATHS,
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
  },
  {
    name: "get_issue_detail",
    description: "Returns the full issue list for either one cluster ID or one issue ID from the most recent check_project or check_files call. Read-only; no files are written or modified. Supply exactly one of clusterId or issueId — supplying both or neither returns an argument error. If the referenced cluster or issue no longer exists in the latest results (e.g., after re-running a check), returns a status: \"stale\" response instead of an error; call check_project or check_files again to refresh.",
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
    description: "Returns all diagnostic issue signatures currently flagged as looping (repeatedly appearing and disappearing) in this server session. Read-only; no files are written or modified. Loop history is accumulated across all check_project and check_files calls in this process lifetime, and is restored from .signalint/session.jsonl on startup. Takes no parameters. Use this to identify which diagnostics an agent is oscillating on; use check_project or check_files to run fresh diagnostics.",
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
      version: "0.3.4",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const cwd = options.cwd ?? process.cwd();
  const sessionMemory = options.sessionMemory ?? new SessionMemory();
  const projectIssueProvider = options.projectIssueProvider === undefined
    ? (paths: readonly string[], signal?: AbortSignal) =>
        collectProjectIssueResult(paths, cwd, signal)
    : wrapIssueProvider(options.projectIssueProvider);
  const fileIssueProvider = options.fileIssueProvider === undefined
    ? (files: readonly string[], signal?: AbortSignal) =>
        checkConfiguredFilesWithStats(files, cwd, signal)
    : wrapIssueProvider(options.fileIssueProvider);
  registerToolHandlers(server, sessionMemory, projectIssueProvider, fileIssueProvider, cwd);
  return server;
}

/** Starts Signalint over stdio and assumes stdin/stdout are owned by an MCP client. */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  const unregisterLifecycle = registerProcessLifecycle(server);
  try {
    await server.connect(transport);
  } catch (error: unknown) {
    unregisterLifecycle();
    await closeRuntimeResources(server).catch((closeError: unknown) => {
      writeFatalError("startup cleanup failed", closeError);
    });
    throw error;
  }
}

/** Runs configured adapters and returns the compact clustered project response. */
export async function checkProject(
  paths: readonly string[],
  cwd: string = process.cwd(),
): Promise<CheckResponse> {
  return (await checkProjectWithIssues(paths, cwd)).response;
}

/** Runs configured adapters and returns both the clustered issues and the project response. */
export async function checkProjectWithIssues(
  paths: readonly string[],
  cwd: string = process.cwd(),
): Promise<ClusterResult> {
  const result = await collectProjectIssueResult(paths, cwd);
  return clusterIssues(result.issues, 10, result.engines);
}

/** Runs enabled project adapters and excludes diagnostics matching configured ignore globs. */
export async function collectProjectIssues(
  paths: readonly string[],
  cwd: string = process.cwd(),
  signal?: AbortSignal,
): Promise<NormalizedIssue[]> {
  return (await collectProjectIssueResult(paths, cwd, signal)).issues;
}

async function collectProjectIssueResult(
  paths: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<IssueProviderResult> {
  const safePaths = (await resolveProjectPaths(paths, cwd)).map((path) => path.relativePath);
  const config = await loadSignalintConfig(cwd);
  const includedPaths = filterIgnoredPaths(safePaths, config.ignore);
  if (includedPaths.length === 0) {
    return {
      issues: [],
      cache: { hits: 0, misses: 0 },
      engines: createIdleEngineStatuses(config.engines),
    };
  }

  const linkedAbort = createLinkedAbortController(signal);
  try {
    const fanout = await settleEngineTasks<NormalizedIssue[]>([
      {
        engine: "oxlint",
        enabled: config.engines.oxlint,
        run: () => runOxlint(includedPaths, {
          cwd,
          signal: linkedAbort.controller.signal,
          timeoutMs: config.timeoutsMs.oxlint,
        }),
      },
      {
        engine: "tsc",
        enabled: config.engines.tsc,
        run: () => runTsc(includedPaths, {
          cwd,
          signal: linkedAbort.controller.signal,
          timeoutMs: config.timeoutsMs.tsc,
        }),
      },
      {
        engine: "biome",
        enabled: config.engines.biome,
        run: () => runBiome(includedPaths, {
          cwd,
          signal: linkedAbort.controller.signal,
          timeoutMs: config.timeoutsMs.biome,
        }),
      },
    ]);
    return {
      issues: filterDefaultExcludedIssues(fanout.results.flat())
        .filter((issue) => !isIgnoredPath(issue.file, config.ignore))
        .sort(compareIssues),
      cache: { hits: 0, misses: 0 },
      engines: fanout.engines,
    };
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
  const safeFiles = (await resolveProjectPaths(files, cwd)).map((path) => path.relativePath);
  const config = await loadSignalintConfig(cwd);
  const includedFiles = filterIgnoredPaths(safeFiles, config.ignore);
  if (includedFiles.length === 0) {
    return {
      issues: [],
      cache: { hits: 0, misses: 0 },
      engines: createIdleEngineStatuses(config.engines),
    };
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
    engines: result.engines,
  };
}

/** Registers all available MCP tool handlers on a configured server and session memory. */
function registerToolHandlers(
  server: Server,
  sessionMemory: SessionMemory,
  projectIssueProvider: IssueProvider,
  fileIssueProvider: IssueProvider,
  cwd: string,
): void {
  const context: ToolHandlerContext = {
    cwd,
    fileIssueProvider,
    latestIssues: [],
    projectIssueProvider,
    sessionMemory,
  };
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    try {
      return await dispatchToolCall(
        request.params.name,
        request.params.arguments,
        extra.signal,
        context,
      );
    } catch (error: unknown) {
      if (error instanceof ZodError || error instanceof ProjectPathError) {
        return createInputRefusal(error);
      }
      throw error;
    }
  });
}

async function dispatchToolCall(
  name: string,
  argumentsValue: unknown,
  signal: AbortSignal,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  if (name === "ping") {
    parsePingArguments(argumentsValue);
    return { content: [{ type: "text", text: "pong" }] };
  }
  if (name === "check_project") {
    return await handleCheckProject(argumentsValue, signal, context);
  }
  if (name === "check_files") {
    return await handleCheckFiles(argumentsValue, signal, context);
  }
  if (name === "get_issue_detail") {
    const reference = parseIssueReference(argumentsValue);
    return createTextResult(resolveIssueDetail(context.latestIssues, reference));
  }
  if (name === "get_loop_status") {
    parseLoopStatusArguments(argumentsValue);
    return createTextResult(context.sessionMemory.getStatus());
  }
  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

async function handleCheckProject(
  argumentsValue: unknown,
  signal: AbortSignal,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const paths = await resolveToolPaths(
    parseCheckProjectArguments(argumentsValue),
    context.cwd,
  );
  return await runContextCheck(paths, signal, context.projectIssueProvider, context);
}

async function handleCheckFiles(
  argumentsValue: unknown,
  signal: AbortSignal,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  const files = await resolveToolPaths(
    parseCheckFilesArguments(argumentsValue),
    context.cwd,
  );
  return await runContextCheck(files, signal, context.fileIssueProvider, context);
}

async function runContextCheck(
  paths: readonly string[],
  signal: AbortSignal,
  provider: IssueProvider,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  return await runCheck(
    paths,
    signal,
    provider,
    context.sessionMemory,
    (issues) => {
      context.latestIssues = issues;
    },
  );
}

function wrapIssueProvider(
  provider: RawIssueProvider,
): IssueProvider {
  return async (paths, signal) => ({
    issues: await provider(paths, signal),
    cache: { hits: 0, misses: 0 },
    engines: createIdleEngineStatuses({ oxlint: true, tsc: true, biome: true }),
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
    const clustered = clusterIssues(
      filterDefaultExcludedIssues(result.issues),
      10,
      result.engines,
    );
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
    if (error instanceof EngineOutputLimitError) {
      logCheckFailure(error);
      return { ...createTextResult(error.response), isError: true };
    }
    if (error instanceof ProjectPathError) {
      return {
        ...createTextResult({ status: "error", code: error.code, message: error.message }),
        isError: true,
      };
    }
    logCheckFailure(error);
    throw error;
  }
}

function logCheckFailure(error: unknown): void {
  const engine = readErrorEngine(error) ?? "unknown";
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[signalint] engine=${engine} check failed: ${detail}\n`);
}

function resolveIssueDetail(
  issues: readonly NormalizedIssue[],
  reference: IssueReference,
): NormalizedIssue[] | StaleReferenceResponse {
  const [key, value] = "clusterId" in reference
    ? ["clusterId", reference.clusterId] as const
    : ["issueId", reference.issueId] as const;
  const matches = issues.filter((issue) => issue[key] === value);
  return matches.length === 0 ? STALE_REFERENCE_RESPONSE : matches;
}

function createTextResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}


async function resolveToolPaths(paths: readonly string[], cwd: string): Promise<string[]> {
  return (await resolveProjectPaths(paths, cwd)).map((path) => path.relativePath);
}

function createInputRefusal(error: ZodError | ProjectPathError): CallToolResult {
  const code = error instanceof ProjectPathError ? error.code : "invalid_arguments";
  const message = error instanceof ZodError ? formatZodError(error) : error.message;
  return {
    ...createTextResult({ status: "error", code, message }),
    isError: true,
  };
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "arguments" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
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
  if (process.argv[2] === "init") {
    if (process.argv.length > 3) {
      process.stderr.write("Usage: signalint-mcp init\n");
      process.exitCode = 2;
    } else {
      process.exitCode = await runInitCommandSafely();
    }
  } else {
    try {
      await startServer();
    } catch (error: unknown) {
      writeFatalError("server startup failed", error);
      process.exitCode = 1;
    }
  }
}
