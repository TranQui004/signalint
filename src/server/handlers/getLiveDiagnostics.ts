import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { clusterIssues } from "../../cluster/clusterEngine.js";
import type { NormalizedIssue } from "../../schema.js";
import { parseGetLiveDiagnosticsArguments } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { resolveToolPaths } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles get_live_diagnostics tool invocation, merging internal engine issues and live buffer diagnostics. */
export async function handleGetLiveDiagnostics(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const { files, severity } = parseGetLiveDiagnosticsArguments(argumentsValue);

  const targetFiles =
    files && files.length > 0
      ? await resolveToolPaths(files, context.cwd)
      : undefined;

  const targetFileSet = targetFiles ? new Set(targetFiles) : undefined;

  const internalSnapshot = context.snapshotStore.getLatestSnapshot(
    (snapshot) => snapshot.source !== "lsp",
  );
  const internalIssues = (internalSnapshot?.issues ?? []).filter((issue) => {
    if (targetFileSet && !targetFileSet.has(issue.file)) {
      return false;
    }
    if (severity && issue.severity !== severity) {
      return false;
    }
    return true;
  });

  const lspIssues =
    context.diagnosticBuffer?.getIssues({
      files: targetFiles,
      severity,
    }) ?? [];

  const mergedIssues: NormalizedIssue[] = [...internalIssues, ...lspIssues];
  const clustered = clusterIssues(mergedIssues, 10, {}, context.cwd);

  return createTextResult(
    {
      status: mergedIssues.length === 0 ? "clean" : "issues_found",
      totalIssues: mergedIssues.length,
      clusters: clustered.response.clusters,
      remainingIssues: clustered.response.remainingIssues ?? [],
      issues: mergedIssues,
    },
    context.payloadMode,
  );
}
