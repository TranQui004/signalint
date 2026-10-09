import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { HookPathError } from "../../hooks/paths.js";
import { ProjectPathError } from "../../projectPaths.js";
import { TransactionManager } from "../../transactions/manager.js";
import { parsePreviewDiagnosticFixArguments } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles preview_diagnostic_fix tool invocation for pure in-memory dry-run previews. */
export async function handlePreviewDiagnosticFix(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const { patches } = parsePreviewDiagnosticFixArguments(argumentsValue);

  const manager = context.transactionManager ?? new TransactionManager();
  context.transactionManager = manager;

  try {
    const preview = manager.prepareTransaction(patches, {
      projectRoot: context.cwd,
    });

    const patchesPreview = preview.patches.map((p) => ({
      file: p.file,
      ...(p.description !== undefined ? { description: p.description } : {}),
      originalLength: p.originalContent.length,
      patchedLength: p.patchedContent.length,
    }));

    return createTextResult(
      {
        transactionId: preview.transactionId,
        filesCount: preview.patches.length,
        summary: `Prepared transactional fix with ${preview.patches.length} patch(es). No files modified on disk.`,
        patchesPreview,
        status: preview.status,
      },
      context.payloadMode,
    );
  } catch (error: unknown) {
    if (error instanceof ProjectPathError || error instanceof HookPathError) {
      throw error;
    }
    return {
      ...createTextResult(
        {
          transactionId: "none",
          filesCount: 0,
          summary: "Failed to prepare transaction",
          patchesPreview: [],
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        },
        context.payloadMode,
      ),
      isError: true,
    };
  }
}
