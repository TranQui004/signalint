import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { parsePingArguments } from "../../toolArguments.js";
import type { ToolHandlerContext } from "../context.js";

/** Handles the MCP ping tool request and returns pong with canonical projectRoot. */
export async function handlePing(
  context: ToolHandlerContext,
  argumentsValue: unknown,
): Promise<CallToolResult> {
  parsePingArguments(argumentsValue);
  if (context.payloadMode === "text") {
    return {
      content: [{ type: "text", text: "pong" }],
    };
  }
  return {
    content: [{ type: "text", text: "pong" }],
    structuredContent: { pong: true, projectRoot: context.cwd },
  };
}
