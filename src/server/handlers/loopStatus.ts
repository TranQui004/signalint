import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { parseLoopStatusArguments } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";
import { createTextResult } from "../errors.js";

/** Handles get_loop_status tool invocation. */
export async function handleLoopStatus(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  parseLoopStatusArguments(argumentsValue);
  return createTextResult(context.sessionMemory.getStatus(), context.payloadMode);
}
