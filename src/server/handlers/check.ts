import { performance } from "node:perf_hooks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { clusterIssues } from "../../cluster/clusterEngine.js";
import { computeDiagnosticDelta, type DiagnosticDelta } from "../../diagnostics/delta.js";
import type { DiagnosticSnapshot } from "../../diagnostics/snapshots.js";
import { ProjectPathError } from "../../projectPaths.js";
import { EngineOutputLimitError } from "../../subprocess.js";
import {
  parseAfterEditCheckArguments,
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

export type ProgressReporter = (
  progress: number,
  total?: number,
  message?: string,
) => Promise<void>;

/** Handles check_project tool invocation. */
export async function handleCheckProject(
  context: ToolHandlerContext,
  argumentsValue: unknown,
  signal: AbortSignal,
  progressReporter?: ProgressReporter,
): Promise<CallToolResult> {
  const paths = await resolveToolPaths(
    parseCheckProjectArguments(argumentsValue),
    context.cwd,
  );
  return await runContextCheck(paths, signal, context.projectIssueProvider, context, "project", undefined, progressReporter);
}

/** Handles check_files tool invocation. */
export async function handleCheckFiles(
  context: ToolHandlerContext,
  argumentsValue: unknown,
  signal: AbortSignal,
  progressReporter?: ProgressReporter,
): Promise<CallToolResult> {
  const files = await resolveToolPaths(
    parseCheckFilesArguments(argumentsValue),
    context.cwd,
  );
  return await runContextCheck(files, signal, context.fileIssueProvider, context, "files", undefined, progressReporter);
}

/** Handles after_edit_check tool invocation. */
export async function handleAfterEditCheck(
  context: ToolHandlerContext,
  argumentsValue: unknown,
  signal: AbortSignal,
  progressReporter?: ProgressReporter,
): Promise<CallToolResult> {
  const { files, baselineCheckId } = parseAfterEditCheckArguments(argumentsValue);
  const resolvedFiles = await resolveToolPaths(files, context.cwd);
  return await runContextCheck(
    resolvedFiles,
    signal,
    context.fileIssueProvider,
    context,
    "files",
    baselineCheckId,
    progressReporter,
  );
}

async function runContextCheck(
  paths: readonly string[],
  signal: AbortSignal,
  provider: IssueProvider,
  context: ToolHandlerContext,
  source: "project" | "files" = "project",
  baselineCheckId?: string,
  progressReporter?: ProgressReporter,
): Promise<CallToolResult> {
  const safetyRefusal = await checkProjectSafety(context.cwd, context.payloadMode);
  if (safetyRefusal !== undefined) {
    return safetyRefusal;
  }
  return await runCheck(
    paths,
    signal,
    provider,
    context,
    source,
    baselineCheckId,
    progressReporter,
  );
}

async function runCheck(
  paths: readonly string[],
  signal: AbortSignal,
  provider: IssueProvider,
  context: ToolHandlerContext,
  source: "project" | "files" = "project",
  baselineCheckId?: string,
  progressReporter?: ProgressReporter,
): Promise<CallToolResult> {
  const startedAt = performance.now();
  const projectRoot = context.cwd;
  const payloadMode: McpPayloadMode = context.payloadMode ?? resolveMcpPayloadMode();

  if (signal.aborted) {
    throw signal.reason ?? new Error("Check cancelled");
  }

  await progressReporter?.(0, 100, "Starting diagnostics...");

  try {
    const result = await provider(paths, signal);
    if (signal.aborted) {
      throw signal.reason ?? new Error("Check cancelled");
    }

    await progressReporter?.(60, 100, "Diagnostics gathered, clustering...");

    const clustered = clusterIssues(
      result.issues,
      10,
      result.engines,
      projectRoot,
      { filteredOutIssueCount: result.filteredOutIssueCount },
    );
    const response = await context.sessionMemory.recordCheck(
      clustered.issues,
      clustered.response,
      result.cache,
      startedAt,
      source,
    );

    const snapshot: DiagnosticSnapshot = {
      checkId: clustered.response.checkId ?? "00000000",
      projectRoot,
      timestamp: Date.now(),
      status: clustered.response.status,
      issues: clustered.issues,
      clusters: clustered.response.clusters,
      remainingIssues: clustered.response.remainingIssues ?? [],
      totalIssues: clustered.response.totalIssues,
      omittedIssueCount: clustered.response.omittedIssueCount ?? 0,
      filteredOutIssueCount: clustered.response.filteredOutIssueCount,
      engines: result.engines,
      cache: result.cache,
      source,
      durationMs: performance.now() - startedAt,
    };
    context.snapshotStore.saveSnapshot(snapshot);

    let delta: DiagnosticDelta | { status: "stale"; code: string; message: string } | undefined;
    if (baselineCheckId !== undefined) {
      const baseline = context.snapshotStore.getSnapshot(baselineCheckId);
      if (baseline) {
        delta = computeDiagnosticDelta(baseline, snapshot);
      } else {
        const isExpired = context.snapshotStore.isExpired(baselineCheckId);
        delta = {
          status: "stale",
          code: isExpired ? "snapshot_expired" : "unknown_check_id",
          message: `Baseline check ID '${baselineCheckId}' ${isExpired ? "has expired" : "is unknown"}.`,
        };
      }
    }

    await progressReporter?.(100, 100, "Diagnostics complete.");

    const finalResponse = delta !== undefined ? { ...response, delta } : response;
    return createTextResult(finalResponse, payloadMode);
  } catch (error: unknown) {
    if (signal.aborted) {
      throw error;
    }
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
