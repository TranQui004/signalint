import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import { type McpPayloadMode, resolveMcpPayloadMode } from "../config.js";
import { HookPathError } from "../hooks/paths.js";
import { ProjectPathError } from "../projectPaths.js";
import type { IssueEngine } from "../schema.js";
import {
  EngineAbortError,
  EngineExecutionError,
  EngineOutputLimitError,
  EngineTimeoutError,
  readErrorEngine,
} from "../subprocess.js";
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
  const structured = createStructuredContent(value);
  const content: CallToolResult["content"] = [
    {
      type: "text",
      text: JSON.stringify(structured),
    },
  ];
  if (mode === "structured") {
    content.push({
      type: "text",
      text: createHumanSummary(value),
      annotations: { audience: ["user"] },
    });
  }
  return {
    content,
    structuredContent: structured,
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

/** Sanitizes error messages by stripping absolute runner paths, stack traces, and sensitive environment data. */
export function sanitizeErrorMessage(rawMessage: string, cwd: string): string {
  let message = rawMessage;
  const stackIndex = message.indexOf("\n    at ");
  if (stackIndex !== -1) {
    message = message.slice(0, stackIndex);
  }
  message = message.replace(/\n\s*at\s+.*$/gm, "");
  if (cwd) {
    message = message.replaceAll(cwd, ".");
    const normalizedCwd = cwd.replace(/\\/g, "/");
    message = message.replaceAll(normalizedCwd, ".");
  }
  message = message.replace(/[A-Za-z]:\\[\w\-.\\]+/g, "[path]");
  message = message.replace(/\/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+/g, "[path]");
  message = message.replace(/(?:[A-Z_]{3,})=\S+/g, "[env]");
  message = message.replace(/Command failed:\s+[^\n]+/g, "Command execution failed");
  return message.replace(/\s+/g, " ").trim();
}

/** Centralizes actionable error classification and message sanitization across engine and provider failures. */
export function createEngineFailureResult(
  error: unknown,
  engine: IssueEngine | "all",
  cwd: string,
  mode: McpPayloadMode = resolveMcpPayloadMode(),
): CallToolResult {
  if (error instanceof EngineAbortError) {
    throw error;
  }
  logCheckFailure(error);

  const resolvedEngine: IssueEngine | "all" =
    readErrorEngine(error) ??
    (error && typeof error === "object" && "engine" in error && typeof error.engine === "string"
      ? (error.engine as IssueEngine)
      : engine);

  let code: string;
  let retryable: boolean;
  let rawMessage: string;
  let nextStep: string;

  if (error instanceof EngineTimeoutError) {
    code = "engine_timeout";
    retryable = true;
    rawMessage = error.message;
    nextStep = "Increase the engine timeout in signalint.config.json or check for hanging processes.";
  } else if (error instanceof EngineOutputLimitError) {
    code = "output_limit_exceeded";
    retryable = false;
    rawMessage = error.message;
    nextStep = "Narrow the scope of checked files or increase maxOutputBytes in signalint.config.json.";
  } else if (error instanceof EngineExecutionError) {
    code = "engine_execution_failed";
    retryable = false;
    rawMessage = error.message;
    nextStep = "Check that the engine CLI is installed and configured correctly in signalint.config.json.";
  } else if (error instanceof ProjectPathError) {
    code = error.code;
    retryable = false;
    rawMessage = error.message;
    nextStep = "Ensure all supplied paths are within the project root directory.";
  } else {
    code = "engine_execution_failed";
    retryable = false;
    rawMessage = error instanceof Error ? error.message : String(error);
    nextStep = "Run signalint doctor to verify environment configuration.";
  }

  const sanitizedMessage = sanitizeErrorMessage(rawMessage, cwd);
  const errorPayload: Record<string, unknown> = {
    status: "error",
    code,
    engine: resolvedEngine,
    message: sanitizedMessage,
    retryable,
    nextStep,
    ...(error instanceof ProjectPathError ? { projectRoot: cwd } : {}),
  };

  return {
    ...createTextResult(errorPayload, mode),
    isError: true,
  };
}
