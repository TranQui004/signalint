import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { parseGetDiagnosticSnapshotArguments } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles get_diagnostic_snapshot tool invocation. */
export async function handleGetDiagnosticSnapshot(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const { checkId } = parseGetDiagnosticSnapshotArguments(argumentsValue);
  const snapshot = context.snapshotStore.getSnapshot(checkId);
  if (!snapshot) {
    if (context.snapshotStore.isExpired(checkId)) {
      return createTextResult(
        {
          status: "stale",
          code: "snapshot_expired",
          message: `Diagnostic snapshot '${checkId}' has expired; run check_project again.`,
        },
        context.payloadMode,
      );
    }
    return createTextResult(
      {
        status: "stale",
        code: "unknown_check_id",
        message: `Check ID '${checkId}' is unknown; run check_project again.`,
      },
      context.payloadMode,
    );
  }
  return createTextResult(
    {
      status: snapshot.status,
      checkId: snapshot.checkId,
      projectRoot: snapshot.projectRoot,
      timestamp: snapshot.timestamp,
      source: snapshot.source,
      durationMs: snapshot.durationMs,
      engines: snapshot.engines,
      totalIssues: snapshot.totalIssues,
      clusters: [...snapshot.clusters],
      remainingIssues: [...snapshot.remainingIssues],
      omittedIssueCount: snapshot.omittedIssueCount,
      filteredOutIssueCount: snapshot.filteredOutIssueCount,
      cache: snapshot.cache,
    },
    context.payloadMode,
  );
}
