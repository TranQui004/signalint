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
    return createTextResult(STALE_REFERENCE_RESPONSE, context.payloadMode);
  }
  return createTextResult(resolveIssueDetail(context.latestIssues, reference), context.payloadMode);
}

function resolveIssueDetail(
  issues: readonly NormalizedIssue[],
  reference: IssueReference,
): NormalizedIssue[] | StaleReferenceResponse {
  if ("clusterId" in reference) {
    const matches = issues.filter((issue) => issue.clusterId === reference.clusterId);
    return matches.length === 0 ? STALE_REFERENCE_RESPONSE : matches;
  }
  const exact = issues.filter((issue) => issue.issueId === reference.issueId);
  if (exact.length > 0) {
    return exact;
  }
  const prefixMatches = issues.filter((issue) => issue.issueId.startsWith(reference.issueId));
  return prefixMatches.length === 0 ? STALE_REFERENCE_RESPONSE : prefixMatches;
}
