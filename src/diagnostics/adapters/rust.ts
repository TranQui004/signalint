import { validateHookPath } from "../../hooks/paths.js";
import {
  createIssueId,
  normalizeIssueMessage,
  type IssueSeverity,
  type NormalizedIssue,
} from "../../schema.js";
import { createDiagnosticSource } from "../provenance.js";

export interface RustAdapterOptions {
  projectRoot: string;
  serverName?: string;
}

interface CargoSpan {
  file_name?: string;
  line_start?: number;
  column_start?: number;
  is_primary?: boolean;
}

interface CargoMessage {
  code?: { code?: string } | null;
  level?: string;
  message?: string;
  spans?: CargoSpan[];
}

interface CargoEvent {
  reason?: string;
  message?: CargoMessage;
}

function parsePayload(input: unknown): unknown[] {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // Fall back to line-by-line
      }
    }
    return trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((item): item is unknown => item !== null);
  }
  return Array.isArray(input) ? input : [input];
}

/** Normalizes Cargo check and Clippy JSON diagnostics into Signalint's unified schema. */
export function normalizeCargoClippyDiagnostics(
  raw: unknown,
  options: RustAdapterOptions,
): NormalizedIssue[] {
  const items = parsePayload(raw);
  const issues: NormalizedIssue[] = [];
  const serverName = options.serverName ?? "cargo-clippy";

  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const event = item as CargoEvent;
    if (event.reason !== undefined && event.reason !== "compiler-message") {
      continue;
    }

    const msg: CargoMessage | undefined = event.message ?? (item as CargoMessage);
    if (!msg || !msg.message || !Array.isArray(msg.spans) || msg.spans.length === 0) {
      continue;
    }

    const primarySpan = msg.spans.find((s) => s.is_primary) ?? msg.spans[0];
    if (!primarySpan || !primarySpan.file_name) {
      continue;
    }

    const normalizedFile = validateHookPath(primarySpan.file_name, options.projectRoot);
    const line = Math.max(1, primarySpan.line_start ?? 1);
    const col = Math.max(1, primarySpan.column_start ?? 1);
    const code = msg.code?.code ?? "cargo";
    const rule = `${serverName}(${code})`;
    const severity: IssueSeverity = msg.level === "error" ? "error" : "warning";
    const message = normalizeIssueMessage(msg.message);
    const issueId = createIssueId(normalizedFile, rule, line, message);

    const kind = severity === "error" && !code.includes("clippy") ? "compiler" : "linter";

    issues.push({
      issueId,
      file: normalizedFile,
      line,
      col,
      engine: "external-lsp",
      rule,
      severity,
      message,
      fixable: false,
      serverName,
      sourceKind: kind,
      provenance: createDiagnosticSource(kind, "external-lsp", serverName),
    });
  }

  return issues;
}
