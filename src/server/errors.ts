import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import { type McpPayloadMode, resolveMcpPayloadMode } from "../config.js";
import { HookPathError } from "../hooks/paths.js";
import { ProjectPathError } from "../projectPaths.js";
import { readErrorEngine } from "../subprocess.js";
import { isRecord } from "../util/index.js";

/** Formats a CallToolResult according to the specified McpPayloadMode. */
export function createTextResult(
  value: unknown,
  mode: McpPayloadMode = resolveMcpPayloadMode(),
): CallToolResult {
  if (mode === "text") {
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
    };
  }
  if (mode === "structured") {
    return {
      content: [{ type: "text", text: createHumanSummary(value) }],
      structuredContent: createStructuredContent(value),
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: createStructuredContent(value),
  };
}

/** Creates a short single-line human summary for structured payload mode. */
export function createHumanSummary(value: unknown): string {
  if (Array.isArray(value)) {
    return `Found ${value.length} issue${value.length === 1 ? "" : "s"}.`;
  }
  if (isRecord(value)) {
    if (value.pong === true) {
      return "pong";
    }
    if (value.status === "clean") {
      return "Clean: 0 issues found.";
    }
    if (value.status === "issues_found") {
      const total = typeof value.totalIssues === "number" ? value.totalIssues : 0;
      return `${total} issue${total === 1 ? "" : "s"} found.`;
    }
    if (value.status === "error") {
      const detail = typeof value.message === "string"
        ? value.message
        : (typeof value.code === "string" ? value.code : "error");
      return `Error: ${sanitizeSummary(detail)}`;
    }
    if (value.status === "stale") {
      const detail = typeof value.message === "string" ? value.message : "stale reference";
      return `Stale: ${sanitizeSummary(detail)}`;
    }
    if (typeof value.looping === "boolean") {
      return value.looping ? "Looping detected." : "No loops detected.";
    }
    if (typeof value.message === "string") {
      return sanitizeSummary(value.message);
    }
  }
  return "OK";
}

function sanitizeSummary(text: string): string {
  return text.replaceAll(/[\r\n]+/g, " ").trim();
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
  error: ZodError | ProjectPathError | HookPathError,
  projectRoot?: string,
  mode: McpPayloadMode = resolveMcpPayloadMode(),
): CallToolResult {
  const code =
    error instanceof ProjectPathError || error instanceof HookPathError
      ? error.code
      : "invalid_arguments";
  const message = error instanceof ZodError ? formatZodError(error) : error.message;
  return {
    ...createTextResult(
      {
        status: "error",
        code,
        message,
        ...(projectRoot !== undefined ? { projectRoot } : {}),
      },
      mode,
    ),
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
