#!/usr/bin/env node

import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import { runTsc } from "./adapters/tsc.js";
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
  readCanonicalProjectRoot,
  readCanonicalProjectRootSync,
  resolveProjectPaths,
} from "./projectPaths.js";
import {
  createSuccessfulEngineStatuses,
  type CheckResponse,
  type EngineStatuses,
  type NormalizedIssue,
  type StaleReferenceResponse,
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
  latestCheckId?: string | undefined;
  projectIssueProvider: IssueProvider;
  sessionMemory: SessionMemory;
}

const STALE_REFERENCE_RESPONSE: StaleReferenceResponse = {
  status: "stale",
  message: "This cluster/issue no longer exists; run check_project again.",
};

const engineStatusOutputSchema = {
  type: "object" as const,
  properties: {
    status: {
      type: "string" as const,
      enum: ["ok", "error", "disabled"] as const,
    },
    message: { type: "string" as const },
  },
  required: ["status"],
  additionalProperties: false,
};

const clusterOutputSchema = {
  type: "object" as const,
  properties: {
    clusterId: { type: "string" as const },
    rootCauseSummary: { type: "string" as const },
    ruleIds: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    issueCount: { type: "integer" as const },
    fileCount: { type: "integer" as const },
    priority: { type: "integer" as const },
    suggestedAction: { type: "string" as const },
    sampleIssueIds: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  required: [
    "clusterId",
    "rootCauseSummary",
    "ruleIds",
    "issueCount",
    "fileCount",
    "priority",
    "suggestedAction",
    "sampleIssueIds",
  ],
  additionalProperties: false,
};

const loopWarningOutputSchema = {
  type: "object" as const,
  properties: {
    signature: { type: "string" as const },
    occurrences: { type: "integer" as const },
    hint: { type: "string" as const },
  },
  required: ["signature", "occurrences", "hint"],
  additionalProperties: false,
};

const fileRuleChurnWarningOutputSchema = {
  type: "object" as const,
  properties: {
    file: { type: "string" as const },
    rule: { type: "string" as const },
    checkCount: { type: "integer" as const },
    hint: { type: "string" as const },
  },
  required: ["file", "rule", "checkCount", "hint"],
  additionalProperties: false,
};

const pingOutputSchema = {
  type: "object" as const,
  properties: {
    pong: {
      type: "boolean" as const,
      description: "True when the server is responsive.",
    },
    projectRoot: {
      type: "string" as const,
      description: "Canonical absolute project root path.",
    },
  },
  required: ["pong", "projectRoot"],
  additionalProperties: false,
};

const checkOutputSchema = {
  type: "object" as const,
  properties: {
    schemaVersion: { type: "string" as const, enum: ["1.3"] as const },
    status: {
      type: "string" as const,
      enum: ["clean", "issues_found", "timeout", "error"] as const,
    },
    projectRoot: { type: "string" as const },
    engines: {
      type: "object" as const,
      properties: {
        oxlint: engineStatusOutputSchema,
        tsc: engineStatusOutputSchema,
        biome: engineStatusOutputSchema,
        eslint: engineStatusOutputSchema,
      },
      required: ["oxlint", "tsc", "biome", "eslint"],
      additionalProperties: false,
    },
    totalIssues: { type: "integer" as const },
    clusters: {
      type: "array" as const,
      items: clusterOutputSchema,
    },
    truncated: { type: "boolean" as const },
    loopWarning: {
      oneOf: [
        loopWarningOutputSchema,
        { type: "null" as const },
      ],
    },
    fileRuleChurnWarning: {
      oneOf: [
        fileRuleChurnWarningOutputSchema,
        { type: "null" as const },
      ],
    },
    engine: {
      type: "string" as const,
      enum: ["oxlint", "tsc", "biome", "eslint"] as const,
    },
    checkId: { type: "string" as const },
    code: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["status"],
};

const normalizedIssueOutputSchema = {
  type: "object" as const,
  properties: {
    issueId: { type: "string" as const },
    file: { type: "string" as const },
    line: { type: "integer" as const },
    col: { type: "integer" as const },
    engine: {
      type: "string" as const,
      enum: ["oxlint", "tsc", "biome", "eslint"] as const,
    },
    rule: { type: "string" as const },
    severity: {
      type: "string" as const,
      enum: ["error", "warning"] as const,
    },
    message: { type: "string" as const },
    fixable: { type: "boolean" as const },
    clusterId: { type: "string" as const },
  },
  required: [
    "issueId",
    "file",
    "line",
    "col",
    "engine",
    "rule",
    "severity",
    "message",
    "fixable",
  ],
  additionalProperties: false,
};

const getIssueDetailOutputSchema = {
  type: "object" as const,
  properties: {
    issues: {
      type: "array" as const,
      items: normalizedIssueOutputSchema,
    },
    status: {
      type: "string" as const,
      enum: ["stale", "error"] as const,
    },
    code: { type: "string" as const },
    message: { type: "string" as const },
  },
};

const getLoopStatusOutputSchema = {
  type: "object" as const,
  properties: {
    looping: { type: "boolean" as const },
    signatures: {
      type: "array" as const,
      items: loopWarningOutputSchema,
    },
    fileChurning: { type: "boolean" as const },
    fileRuleChurns: {
      type: "array" as const,
      items: fileRuleChurnWarningOutputSchema,
    },
  },
  required: ["looping", "signatures", "fileChurning", "fileRuleChurns"],
  additionalProperties: false,
};

/** Hints applied uniformly to every tool: local-only reads, no external writes or network. */
const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const tools = [
  {
    name: "ping",
    description: "Checks whether the Signalint MCP server is responsive. Read-only; returns the string \"pong\" with no side effects. Use this to verify the server is connected before running diagnostics. Invalid arguments return an error response; no authentication is required.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
    },
    outputSchema: pingOutputSchema,
    annotations: TOOL_ANNOTATIONS,
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
    outputSchema: checkOutputSchema,
    annotations: TOOL_ANNOTATIONS,
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
    outputSchema: checkOutputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
  {
    name: "get_issue_detail",
    description: "Returns the full issue list for either one cluster ID or one issue ID from the most recent check_project or check_files call. Read-only; no files are written or modified. Supply exactly one of clusterId or issueId — supplying both or neither returns an argument error. If the referenced cluster or issue no longer exists in the latest results (e.g., after re-running a check), returns a status: \"stale\" response instead of an error; call check_project or check_files again to refresh.",
    inputSchema: {
      type: "object" as const,
      properties: {
        clusterId: { type: "string" as const },
        issueId: { type: "string" as const },
        checkId: { type: "string" as const },
      },
      oneOf: [
        { required: ["clusterId"] },
        { required: ["issueId"] },
      ],
      additionalProperties: false,
    },
    outputSchema: getIssueDetailOutputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
  {
    name: "get_loop_status",
    description: "Returns all diagnostic issue signatures currently flagged as looping (repeatedly appearing and disappearing) in this server session. Read-only; no files are written or modified. Loop history is accumulated across all check_project and check_files calls in this process lifetime, and is restored from .signalint/session.jsonl on startup. Takes no parameters. Use this to identify which diagnostics an agent is oscillating on; use check_project or check_files to run fresh diagnostics.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
    },
    outputSchema: getLoopStatusOutputSchema,
    annotations: TOOL_ANNOTATIONS,
  },
];

/** Creates the Signalint MCP server with process-lifetime loop memory and optional test providers. */
export function createServer(options: SignalintServerOptions = {}): Server {
  const server = new Server(
    {
      name: "signalint",
      version: "0.4.2",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  let projectRoot: string;
  const envRoot = process.env.SIGNALINT_PROJECT_ROOT;
  if (options.cwd !== undefined) {
    try {
      projectRoot = readCanonicalProjectRootSync(options.cwd);
    } catch {
      projectRoot = resolve(options.cwd);
    }
  } else if (envRoot !== undefined && envRoot.trim() !== "") {
    try {
      projectRoot = readCanonicalProjectRootSync(envRoot);
    } catch (error: unknown) {
      process.stderr.write(
        `[signalint] Invalid SIGNALINT_PROJECT_ROOT: ${error instanceof Error ? error.message : String(error)}. Falling back to process.cwd().\n`,
      );
      try {
        projectRoot = readCanonicalProjectRootSync(process.cwd());
      } catch {
        projectRoot = resolve(process.cwd());
      }
    }
  } else {
    try {
      projectRoot = readCanonicalProjectRootSync(process.cwd());
    } catch {
      projectRoot = resolve(process.cwd());
    }
  }

  process.stderr.write(`[signalint] project root: ${projectRoot}\n`);

  const cwd = projectRoot;
  const sessionMemory = options.sessionMemory ?? new SessionMemory({
    logPath: resolve(cwd, ".signalint", "session.jsonl"),
  });
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
  const projectRoot = await readCanonicalProjectRoot(cwd);
  return clusterIssues(result.issues, 10, result.engines, projectRoot);
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

  const files = await expandPathsToFiles(includedPaths, cwd, config.ignore);
  if (files.length === 0) {
    return {
      issues: [],
      cache: { hits: 0, misses: 0 },
      engines: createIdleEngineStatuses(config.engines),
    };
  }

  const checkResult = await checkFilesWithStats(files, {
    cwd,
    engines: config.engines,
    timeoutsMs: config.timeoutsMs,
    signal,
    targetPath: includedPaths[0],
    runners: {
      tsc: (options) => runTsc(includedPaths, options),
    },
  });

  return {
    issues: filterDefaultExcludedIssues(checkResult.issues)
      .filter((issue) => !isIgnoredPath(issue.file, config.ignore))
      .sort(compareIssues),
    cache: checkResult.cache,
    engines: checkResult.engines,
  };
}

async function expandPathsToFiles(
  paths: readonly string[],
  cwd: string,
  ignoreGlobs: readonly string[],
): Promise<string[]> {
  const fileSet = new Set<string>();
  const visitedDirs = new Set<string>();

  async function walk(relativeTarget: string): Promise<void> {
    const absoluteTarget = resolve(cwd, relativeTarget);
    let targetStat;
    try {
      targetStat = await stat(absoluteTarget);
    } catch {
      return;
    }

    if (targetStat.isFile()) {
      if (!isIgnoredPath(relativeTarget, ignoreGlobs)) {
        fileSet.add(relativeTarget);
      }
      return;
    }

    if (!targetStat.isDirectory()) {
      return;
    }

    if (visitedDirs.has(absoluteTarget) || fileSet.size >= 2000) {
      return;
    }
    visitedDirs.add(absoluteTarget);

    let entries;
    try {
      entries = await readdir(absoluteTarget, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".signalint" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const childRelative = relativeTarget === "."
        ? entry.name
        : `${relativeTarget.replace(/\/$/, "")}/${entry.name}`;
      if (isIgnoredPath(childRelative, ignoreGlobs)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(childRelative);
      } else if (entry.isFile()) {
        fileSet.add(childRelative);
      }
    }
  }

  for (const p of paths) {
    await walk(p);
  }

  return Array.from(fileSet);
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
        return createInputRefusal(error, context.cwd);
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
    return {
      content: [{ type: "text", text: "pong" }],
      structuredContent: { pong: true, projectRoot: context.cwd },
    };
  }
  if (name === "check_project") {
    return await handleCheckProject(argumentsValue, signal, context);
  }
  if (name === "check_files") {
    return await handleCheckFiles(argumentsValue, signal, context);
  }
  if (name === "get_issue_detail") {
    const reference = parseIssueReference(argumentsValue);
    if (
      reference.checkId !== undefined &&
      (context.latestCheckId === undefined || reference.checkId !== context.latestCheckId)
    ) {
      return createTextResult(STALE_REFERENCE_RESPONSE);
    }
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
  return await runContextCheck(files, signal, context.fileIssueProvider, context, "files");
}

async function runContextCheck(
  paths: readonly string[],
  signal: AbortSignal,
  provider: IssueProvider,
  context: ToolHandlerContext,
  source: "project" | "files" = "project",
): Promise<CallToolResult> {
  const safetyRefusal = await checkProjectSafety(context.cwd);
  if (safetyRefusal !== undefined) {
    return safetyRefusal;
  }
  return await runCheck(
    paths,
    signal,
    provider,
    context.sessionMemory,
    (issues, checkId) => {
      context.latestIssues = issues;
      context.latestCheckId = checkId;
    },
    source,
    context.cwd,
  );
}

async function checkProjectSafety(projectRoot: string): Promise<CallToolResult | undefined> {
  let hasConfigFile = false;
  try {
    await stat(resolve(projectRoot, "signalint.config.json"));
    hasConfigFile = true;
  } catch {
    hasConfigFile = false;
  }

  if (!hasConfigFile && process.env.SIGNALINT_ALLOW_UNINITIALIZED !== "1") {
    return {
      ...createTextResult({
        status: "error",
        code: "project_not_initialized",
        message: `Run 'npx signalint-mcp init' in ${projectRoot} before checking it.`,
        projectRoot,
      }),
      isError: true,
    };
  }

  const isJs = await hasJsProjectMarkers(projectRoot);
  if (!isJs) {
    return {
      ...createTextResult({
        status: "error",
        code: "not_a_js_project",
        message: `No JavaScript or TypeScript project markers found in ${projectRoot}.`,
        projectRoot,
      }),
      isError: true,
    };
  }

  return undefined;
}

async function hasJsProjectMarkers(projectRoot: string): Promise<boolean> {
  try {
    const rootEntries = await readdir(projectRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile()) {
        const name = entry.name.toLowerCase();
        if (name === "package.json" || name === "tsconfig.json") {
          return true;
        }
        if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i.test(name)) {
          return true;
        }
      }
    }

    let count = rootEntries.length;
    const queue: string[] = [];
    for (const entry of rootEntries) {
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        queue.push(resolve(projectRoot, entry.name));
      }
    }

    while (queue.length > 0 && count < 2000) {
      const currentDir = queue.shift();
      if (!currentDir) {
        break;
      }
      let subEntries;
      try {
        subEntries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of subEntries) {
        count++;
        if (entry.isFile()) {
          if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i.test(entry.name)) {
            return true;
          }
        } else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
          queue.push(resolve(currentDir, entry.name));
        }
        if (count >= 2000) {
          break;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

function wrapIssueProvider(
  provider: RawIssueProvider,
): IssueProvider {
  return async (paths, signal) => ({
    issues: await provider(paths, signal),
    cache: { hits: 0, misses: 0 },
    engines: createSuccessfulEngineStatuses(),
  });
}

async function runCheck(
  paths: readonly string[],
  signal: AbortSignal,
  provider: IssueProvider,
  sessionMemory: SessionMemory,
  saveIssues: (issues: NormalizedIssue[], checkId?: string) => void,
  source: "project" | "files" = "project",
  projectRoot: string = process.cwd(),
): Promise<CallToolResult> {
  const startedAt = performance.now();
  try {
    const result = await provider(paths, signal);
    const clustered = clusterIssues(
      filterDefaultExcludedIssues(result.issues),
      10,
      result.engines,
      projectRoot,
    );
    const response = await sessionMemory.recordCheck(
      clustered.issues,
      clustered.response,
      result.cache,
      startedAt,
      source,
    );
    saveIssues(clustered.issues, clustered.response.checkId);
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
        ...createTextResult({ status: "error", code: error.code, message: error.message, projectRoot }),
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
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: createStructuredContent(value),
  };
}

function createStructuredContent(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { issues: value };
  }
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return { value };
}


async function resolveToolPaths(paths: readonly string[], cwd: string): Promise<string[]> {
  return (await resolveProjectPaths(paths, cwd)).map((path) => path.relativePath);
}

function createInputRefusal(error: ZodError | ProjectPathError, projectRoot?: string): CallToolResult {
  const code = error instanceof ProjectPathError ? error.code : "invalid_arguments";
  const message = error instanceof ZodError ? formatZodError(error) : error.message;
  return {
    ...createTextResult({
      status: "error",
      code,
      message,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    }),
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
