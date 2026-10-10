import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { clusterIssues } from "../../cluster/clusterEngine.js";
import { computeDiagnosticDelta } from "../../diagnostics/delta.js";
import type { DiagnosticSnapshot } from "../../diagnostics/snapshots.js";
import { TransactionManager } from "../../transactions/manager.js";
import { parseApplyDiagnosticFixArguments } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles apply_diagnostic_fix tool invocation for atomic reversible patch execution. */
export async function handleApplyDiagnosticFix(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const { transactionId, confirm, baselineCheckId } = parseApplyDiagnosticFixArguments(argumentsValue);

  if (confirm !== true) {
    return {
      ...createTextResult(
        {
          transactionId,
          status: "error",
          filesModified: [],
          error: "Confirmation required: set confirm=true to apply transaction.",
        },
        context.payloadMode,
      ),
      isError: true,
    };
  }

  const manager = context.transactionManager ?? new TransactionManager();
  context.transactionManager = manager;

  const result = await manager.applyTransaction(transactionId, {
    projectRoot: context.cwd,
    confirm,
    onPostCheck: async (filesModified) => {
      const checkResult = await context.fileIssueProvider(filesModified);
      const clustered = clusterIssues(
        checkResult.issues,
        10,
        checkResult.engines,
        context.cwd,
        { filteredOutIssueCount: checkResult.filteredOutIssueCount },
      );
      const postCheckId = clustered.response.checkId ?? "00000000";
      const postSnapshot: DiagnosticSnapshot = {
        checkId: postCheckId,
        projectRoot: context.cwd,
        timestamp: Date.now(),
        status: clustered.response.status,
        issues: clustered.issues,
        clusters: clustered.response.clusters,
        remainingIssues: clustered.response.remainingIssues ?? [],
        totalIssues: clustered.response.totalIssues,
        omittedIssueCount: clustered.response.omittedIssueCount ?? 0,
        filteredOutIssueCount: clustered.response.filteredOutIssueCount,
        engines: checkResult.engines,
        cache: checkResult.cache,
        source: "files",
        durationMs: 0,
      };
      context.snapshotStore.saveSnapshot(postSnapshot);

      let delta: unknown | undefined;
      let message: string | undefined;
      if (baselineCheckId !== undefined) {
        const baseline = context.snapshotStore.getSnapshot(baselineCheckId);
        if (baseline) {
          delta = computeDiagnosticDelta(baseline, postSnapshot);
        } else {
          const isExpired = context.snapshotStore.isExpired(baselineCheckId);
          message = `Baseline check '${baselineCheckId}' ${isExpired ? "has expired" : "was not found"}; baseline delta was not computed.`;
        }
      } else {
        message = "No baselineCheckId provided; baseline delta was not requested.";
      }
      return { postCheckId, delta, message };
    },
  });

  const isError = result.status !== "success";
  return {
    ...createTextResult(result, context.payloadMode),
    ...(isError ? { isError: true } : {}),
  };
}
