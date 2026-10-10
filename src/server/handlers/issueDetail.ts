import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { resolveIssuesInSnapshot } from "../../diagnostics/snapshots.js";
import { parseIssueReference } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles get_issue_detail tool invocation anchored to an explicit checkId. */
export async function handleIssueDetail(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const reference = parseIssueReference(argumentsValue);
  const checkId = reference.checkId;
  if (!checkId) {
    return createTextResult(
      {
        status: "stale",
        code: "unknown_check_id",
        message: "Check ID is required for get_issue_detail.",
      },
      context.payloadMode,
    );
  }

  const snapshot = context.snapshotStore.getSnapshot(checkId);
  if (!snapshot) {
    const isExpired = context.snapshotStore.isExpired(checkId);
    return createTextResult(
      {
        status: "stale",
        code: isExpired ? "snapshot_expired" : "unknown_check_id",
        message: isExpired
          ? `Diagnostic snapshot '${checkId}' has expired; run check_project again.`
          : `Check ID '${checkId}' is unknown; run check_project again.`,
      },
      context.payloadMode,
    );
  }

  const result = resolveIssuesInSnapshot(snapshot, reference);
  return createTextResult(result, context.payloadMode);
}
