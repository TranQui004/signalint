import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { TransactionManager } from "../../transactions/manager.js";
import { parseDiscardDiagnosticFixArguments } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles discard_diagnostic_fix tool invocation to drop an in-memory preview. */
export async function handleDiscardDiagnosticFix(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  const { transactionId } = parseDiscardDiagnosticFixArguments(argumentsValue);

  const manager = context.transactionManager ?? new TransactionManager();
  context.transactionManager = manager;

  const discarded = manager.discardTransaction(transactionId);

  return createTextResult(
    {
      transactionId,
      discarded,
    },
    context.payloadMode,
  );
}
