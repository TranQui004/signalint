import { performance } from "node:perf_hooks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { clusterIssues } from "../../cluster/clusterEngine.js";
import type { SessionMemory } from "../../memory/sessionMemory.js";
import { ProjectPathError } from "../../projectPaths.js";
import type { NormalizedIssue } from "../../schema.js";
import { EngineOutputLimitError } from "../../subprocess.js";
import {
  parseCheckFilesArguments,
  parseCheckProjectArguments,
} from "../../toolArguments.js";
import {
  checkProjectSafety,
  resolveToolPaths,
  type IssueProvider,
  type ToolHandlerContext,
} from "../context.js";
import { type McpPayloadMode, resolveMcpPayloadMode } from "../../config.js";
import { createTextResult, logCheckFailure } from "../errors.js";

/** Handles check_project tool invocation. */
export async function handleCheckProject(
  context: ToolHandlerContext,
  argumentsValue: unknown,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const paths = await resolveToolPaths(
    parseCheckProjectArguments(argumentsValue),
    context.cwd,
  );
  return await runContextCheck(paths, signal, context.projectIssueProvider, context);
}

/** Handles check_files tool invocation. */
export async function handleCheckFiles(
  context: ToolHandlerContext,
  argumentsValue: unknown,
  signal: AbortSignal,
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
  const safetyRefusal = await checkProjectSafety(context.cwd, context.payloadMode);
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
    context.payloadMode,
  );
}

async function runCheck(
  paths: readonly string[],
  signal: AbortSignal,
  provider: IssueProvider,
  sessionMemory: SessionMemory,
  saveIssues: (issues: NormalizedIssue[], checkId?: string) => void,
  source: "project" | "files" = "project",
  projectRoot: string = process.cwd(),
  payloadMode: McpPayloadMode = resolveMcpPayloadMode(),
): Promise<CallToolResult> {
  const startedAt = performance.now();
  try {
    const result = await provider(paths, signal);
    // Single exclusion pass preserved: provider boundary already filtered exclusions.
    const clustered = clusterIssues(
      result.issues,
      10,
      result.engines,
      projectRoot,
      { filteredOutIssueCount: result.filteredOutIssueCount },
    );
    const response = await sessionMemory.recordCheck(
      clustered.issues,
      clustered.response,
      result.cache,
      startedAt,
      source,
    );
    saveIssues(clustered.issues, clustered.response.checkId);
    return createTextResult(response, payloadMode);
  } catch (error: unknown) {
    if (error instanceof EngineOutputLimitError) {
      logCheckFailure(error);
      return { ...createTextResult(error.response, payloadMode), isError: true };
    }
    if (error instanceof ProjectPathError) {
      return {
        ...createTextResult({ status: "error", code: error.code, message: error.message, projectRoot }, payloadMode),
        isError: true,
      };
    }
    logCheckFailure(error);
    throw error;
  }
}
