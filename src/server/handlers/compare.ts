import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { computeDiagnosticDelta } from "../../diagnostics/delta.js";
import { parseCompareDiagnosticsArguments } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles compare_diagnostics tool invocation. */
export async function handleCompareDiagnostics(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const { baselineCheckId, currentCheckId } = parseCompareDiagnosticsArguments(argumentsValue);
  const baseline = context.snapshotStore.getSnapshot(baselineCheckId);
  if (!baseline) {
    const isExpired = context.snapshotStore.isExpired(baselineCheckId);
    return createTextResult(
      {
        status: "stale",
        code: isExpired ? "snapshot_expired" : "unknown_check_id",
        message: `Baseline check ID '${baselineCheckId}' ${isExpired ? "has expired" : "is unknown"}.`,
      },
      context.payloadMode,
    );
  }
  const current = context.snapshotStore.getSnapshot(currentCheckId);
  if (!current) {
    const isExpired = context.snapshotStore.isExpired(currentCheckId);
    return createTextResult(
      {
        status: "stale",
        code: isExpired ? "snapshot_expired" : "unknown_check_id",
        message: `Current check ID '${currentCheckId}' ${isExpired ? "has expired" : "is unknown"}.`,
      },
      context.payloadMode,
    );
  }

  const delta = computeDiagnosticDelta(baseline, current);
  return createTextResult(
    {
      status: "ok",
      baselineId: delta.baselineCheckId,
      currentId: delta.currentCheckId,
      baselineCheckId: delta.baselineCheckId,
      currentCheckId: delta.currentCheckId,
      errorsIntroduced: delta.errorsIntroduced,
      errorsResolved: delta.errorsResolved,
      netDelta: delta.netDelta,
      introducedIssues: delta.introducedIssues,
      resolvedIssues: delta.resolvedIssues,
      unchangedIssues: delta.unchangedIssues,
      nextStep: delta.nextStep,
    },
    context.payloadMode,
  );
}
