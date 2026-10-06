import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { NormalizedIssue, StaleReferenceResponse } from "../../schema.js";
import { parseIssueReference, type IssueReference } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";
import { STALE_REFERENCE_RESPONSE } from "../toolSchemas.js";

/** Handles get_issue_detail tool invocation with optional freshness validation. */
export async function handleIssueDetail(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const reference = parseIssueReference(argumentsValue);
  if (
    reference.checkId !== undefined &&
    (context.latestCheckId === undefined || reference.checkId !== context.latestCheckId)
  ) {
    return createTextResult(STALE_REFERENCE_RESPONSE);
  }
  return createTextResult(resolveIssueDetail(context.latestIssues, reference));
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
