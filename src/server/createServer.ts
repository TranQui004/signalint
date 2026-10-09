import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import {
  checkConfiguredFilesWithStats,
  collectProjectIssueResult,
} from "../check/checkProject.js";
import {
  loadSignalintConfigSync,
  resolveMcpPayloadMode,
  type McpPayloadMode,
} from "../config.js";
import {
  closeRuntimeResources,
  registerProcessLifecycle,
  writeFatalError,
} from "../lifecycle.js";
import { SessionMemory } from "../memory/sessionMemory.js";
import {
  ProjectPathError,
  readCanonicalProjectRootSync,
} from "../projectPaths.js";
import {
  wrapIssueProvider,
  type IssueProvider,
  type TestIssueProvider,
  type ToolHandlerContext,
} from "./context.js";
import { isRecord } from "../util/index.js";
import { resolveSignalintVersion } from "../version.js";
import { createInputRefusal } from "./errors.js";
import { handleCheckFiles, handleCheckProject } from "./handlers/check.js";
import { handleIssueDetail } from "./handlers/issueDetail.js";
import { handleLoopStatus } from "./handlers/loopStatus.js";
import { handlePing } from "./handlers/ping.js";
import { createTools } from "./tools.js";

export interface SignalintServerOptions {
  cwd?: string | undefined;
  fileIssueProvider?: TestIssueProvider | undefined;
  projectIssueProvider?: TestIssueProvider | undefined;
  sessionMemory?: SessionMemory | undefined;
  payloadMode?: McpPayloadMode | undefined;
}

/** Creates the Signalint MCP server with process-lifetime loop memory and optional test providers. */
export function createServer(options: SignalintServerOptions = {}): Server {
  const server = new Server(
    {
      name: "signalint",
      version: resolveSignalintVersion(),
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
  const stateDir = process.env.SIGNALINT_STATE_DIR?.trim();
  const sessionLogPath = stateDir && stateDir !== ""
    ? resolve(stateDir, "session.jsonl")
    : resolve(cwd, ".signalint", "session.jsonl");
  const sessionMemory = options.sessionMemory ?? new SessionMemory({
    logPath: sessionLogPath,
  });
  const projectIssueProvider = options.projectIssueProvider === undefined
    ? (paths: readonly string[], signal?: AbortSignal) =>
        collectProjectIssueResult(paths, cwd, signal)
    : wrapIssueProvider(options.projectIssueProvider);
  const fileIssueProvider = options.fileIssueProvider === undefined
    ? (files: readonly string[], signal?: AbortSignal) =>
        checkConfiguredFilesWithStats(files, cwd, signal)
    : wrapIssueProvider(options.fileIssueProvider);

  const config = loadSignalintConfigSync(cwd);
  const payloadMode = resolveMcpPayloadMode(options.payloadMode ?? config.mcpPayload);

  registerToolHandlers(server, sessionMemory, projectIssueProvider, fileIssueProvider, cwd, payloadMode);
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

/** Registers all available MCP tool handlers on a configured server and session memory. */
function registerToolHandlers(
  server: Server,
  sessionMemory: SessionMemory,
  projectIssueProvider: IssueProvider,
  fileIssueProvider: IssueProvider,
  cwd: string,
  payloadMode: McpPayloadMode,
): void {
  const context: ToolHandlerContext = {
    cwd,
    fileIssueProvider,
    latestIssues: [],
    projectIssueProvider,
    sessionMemory,
    payloadMode,
  };
  const activeTools = createTools(payloadMode);
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: activeTools }));
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
        return createInputRefusal(error, context.cwd, context.payloadMode);
      }
      throw error;
    }
  });
}

/** Dispatches an MCP tool call to the appropriate handler and validates request structure. */
export async function dispatchToolCall(
  name: string,
  argumentsValue: unknown,
  signal: AbortSignal,
  context: ToolHandlerContext,
): Promise<CallToolResult> {
  if (argumentsValue !== undefined && !isRecord(argumentsValue)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Malformed tool arguments: arguments must be an object for tool '${name}'.`,
    );
  }
  if (name === "ping") {
    return await handlePing(context, argumentsValue);
  }
  if (name === "check_project") {
    return await handleCheckProject(context, argumentsValue, signal);
  }
  if (name === "check_files") {
    return await handleCheckFiles(context, argumentsValue, signal);
  }
  if (name === "get_issue_detail") {
    return await handleIssueDetail(context, argumentsValue);
  }
  if (name === "get_loop_status") {
    return await handleLoopStatus(context, argumentsValue);
  }
  throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
}
