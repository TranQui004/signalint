import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { parseIssueReference } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles get_issue_detail tool invocation with optional freshness validation. */
export async function handleIssueDetail(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const reference = parseIssueReference(argumentsValue);
  const result = context.snapshotStore.resolveIssues(reference, reference.checkId);
  return createTextResult(result, context.payloadMode);
}
