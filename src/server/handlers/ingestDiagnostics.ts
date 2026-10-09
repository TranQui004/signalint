import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { clusterIssues } from "../../cluster/clusterEngine.js";
import { DiagnosticBuffer } from "../../diagnostics/buffer.js";
import { normalizeLspDiagnostic } from "../../diagnostics/normalize.js";
import type { DiagnosticSnapshot } from "../../diagnostics/snapshots.js";
import type { NormalizedIssue } from "../../schema.js";
import { parseIngestDiagnosticsArguments } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles ingest_diagnostics tool invocation. */
export async function handleIngestDiagnostics(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const { source, serverName, diagnostics } =
    parseIngestDiagnosticsArguments(argumentsValue);

  const normalizedIssues: NormalizedIssue[] = [];
  for (const raw of diagnostics) {
    const issue = normalizeLspDiagnostic(raw, {
      projectRoot: context.cwd,
      source,
      serverName,
    });
    if (issue !== null) {
      normalizedIssues.push(issue);
    }
  }

  const buffer = context.diagnosticBuffer ?? new DiagnosticBuffer();
  context.diagnosticBuffer = buffer;
  buffer.ingest(normalizedIssues);

  const clustered = clusterIssues(
    normalizedIssues,
    10,
    { "external-lsp": { status: "ok" } },
    context.cwd,
  );

  const checkId = clustered.response.checkId ?? "00000000";

  const snapshot: DiagnosticSnapshot = {
    checkId,
    projectRoot: context.cwd,
    timestamp: Date.now(),
    status: clustered.response.status,
    issues: clustered.issues,
    clusters: clustered.response.clusters,
    remainingIssues: clustered.response.remainingIssues ?? [],
    totalIssues: clustered.response.totalIssues,
    omittedIssueCount: clustered.response.omittedIssueCount ?? 0,
    filteredOutIssueCount: clustered.response.filteredOutIssueCount,
    engines: { "external-lsp": { status: "ok" } },
    source: "lsp",
  };

  context.snapshotStore.saveSnapshot(snapshot);
  context.latestCheckId = checkId;

  return createTextResult(
    {
      snapshotId: checkId,
      checkId,
      totalIssues: snapshot.totalIssues,
      clusters: snapshot.clusters,
      remainingIssues: snapshot.remainingIssues,
    },
    context.payloadMode,
  );
}
