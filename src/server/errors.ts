import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import { ProjectPathError } from "../projectPaths.js";
import { readErrorEngine } from "../subprocess.js";

/** Formats a text result alongside its structuredContent matching MCP conventions. */
export function createTextResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: createStructuredContent(value),
  };
}

/** Wraps value into an object suitable for structuredContent if it is not already an object. */
export function createStructuredContent(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { issues: value };
  }
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/** Formats an argument error or path containment error as a structured MCP tool error. */
export function createInputRefusal(
  error: ZodError | ProjectPathError,
  projectRoot?: string,
): CallToolResult {
  const code = error instanceof ProjectPathError ? error.code : "invalid_arguments";
  const message = error instanceof ZodError ? formatZodError(error) : error.message;
  return {
    ...createTextResult({
      status: "error",
      code,
      message,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    }),
    isError: true,
  };
}

/** Logs internal engine check failures to stderr for maintainer visibility. */
export function logCheckFailure(error: unknown): void {
  const engine = readErrorEngine(error) ?? "unknown";
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[signalint] engine=${engine} check failed: ${detail}\n`);
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "arguments" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
