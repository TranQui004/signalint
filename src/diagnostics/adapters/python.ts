import { validateHookPath } from "../../hooks/paths.js";
import {
  createIssueId,
  normalizeIssueMessage,
  type IssueSeverity,
  type NormalizedIssue,
} from "../../schema.js";
import { createDiagnosticSource } from "../provenance.js";

export interface PythonAdapterOptions {
  projectRoot: string;
  defaultSeverity?: IssueSeverity;
}

interface RawRuffIssue {
  filename?: string;
  code?: string;
  message?: string;
  location?: {
    row?: number;
    column?: number;
  };
  fix?: unknown;
}

interface RawMypyIssue {
  file?: string;
  line?: number;
  column?: number;
  message?: string;
  severity?: string;
  code?: string;
}

function parsePayload(input: unknown): unknown[] {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // Fall back to line-by-line JSON parsing
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

/** Normalizes Ruff JSON diagnostics into Signalint's unified schema. */
export function normalizeRuffDiagnostics(
  raw: unknown,
  options: PythonAdapterOptions,
): NormalizedIssue[] {
  const items = parsePayload(raw);
  const issues: NormalizedIssue[] = [];

  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const ruff = item as RawRuffIssue;
    if (!ruff.filename || !ruff.message) {
      continue;
    }

    const normalizedFile = validateHookPath(ruff.filename, options.projectRoot);
    const line = Math.max(1, ruff.location?.row ?? 1);
    const col = Math.max(1, ruff.location?.column ?? 1);
    const code = ruff.code ?? "ruff";
    const rule = `ruff(${code})`;
    const severity: IssueSeverity =
      code.startsWith("E") || code.startsWith("F")
        ? (options.defaultSeverity ?? "error")
        : (options.defaultSeverity ?? "warning");
    const message = normalizeIssueMessage(ruff.message);
    const issueId = createIssueId(normalizedFile, rule, line, message);

    issues.push({
      issueId,
      file: normalizedFile,
      line,
      col,
      engine: "external-lsp",
      rule,
      severity,
      message,
      fixable: ruff.fix !== null && ruff.fix !== undefined,
      serverName: "ruff",
      sourceKind: "linter",
      provenance: createDiagnosticSource("linter", "external-lsp", "ruff"),
    });
  }

  return issues;
}

/** Normalizes Mypy JSON diagnostics into Signalint's unified schema. */
export function normalizeMypyDiagnostics(
  raw: unknown,
  options: PythonAdapterOptions,
): NormalizedIssue[] {
  const items = parsePayload(raw);
  const issues: NormalizedIssue[] = [];

  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const mypy = item as RawMypyIssue;
    if (!mypy.file || !mypy.message) {
      continue;
    }

    const normalizedFile = validateHookPath(mypy.file, options.projectRoot);
    const line = Math.max(1, mypy.line ?? 1);
    const col = Math.max(1, mypy.column ?? 1);
    const rule = mypy.code ? `mypy(${mypy.code})` : "mypy";
    const severity: IssueSeverity =
      mypy.severity?.toLowerCase() === "error"
        ? "error"
        : (options.defaultSeverity ?? "warning");
    const message = normalizeIssueMessage(mypy.message);
    const issueId = createIssueId(normalizedFile, rule, line, message);

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
      serverName: "mypy",
      sourceKind: "compiler",
      provenance: createDiagnosticSource("compiler", "external-lsp", "mypy"),
    });
  }

  return issues;
}
