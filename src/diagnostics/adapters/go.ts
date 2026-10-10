import { validateHookPath } from "../../hooks/paths.js";
import {
  createIssueId,
  normalizeIssueMessage,
  type IssueSeverity,
  type NormalizedIssue,
} from "../../schema.js";
import { createDiagnosticSource } from "../provenance.js";

export interface GoAdapterOptions {
  projectRoot: string;
}

interface RawGolangIssue {
  FromLinter?: string;
  Text?: string;
  Severity?: string;
  Pos?: {
    Filename?: string;
    Line?: number;
    Column?: number;
  };
}

interface RawGolangReport {
  Issues?: RawGolangIssue[];
}

function extractIssues(input: unknown): RawGolangIssue[] {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input.trim());
      return extractIssues(parsed);
    } catch {
      return [];
    }
  }
  if (typeof input === "object" && input !== null) {
    if (Array.isArray(input)) {
      return input as RawGolangIssue[];
    }
    const report = input as RawGolangReport;
    if (Array.isArray(report.Issues)) {
      return report.Issues;
    }
    return [input as RawGolangIssue];
  }
  return [];
}

/** Normalizes golangci-lint JSON diagnostics into Signalint's unified schema. */
export function normalizeGolangCiLintDiagnostics(
  raw: unknown,
  options: GoAdapterOptions,
): NormalizedIssue[] {
  const items = extractIssues(raw);
  const issues: NormalizedIssue[] = [];

  for (const item of items) {
    if (!item.Pos?.Filename || !item.Text) {
      continue;
    }

    const normalizedFile = validateHookPath(item.Pos.Filename, options.projectRoot);
    const line = Math.max(1, item.Pos.Line ?? 1);
    const col = Math.max(1, item.Pos.Column ?? 1);
    const linter = item.FromLinter ?? "golangci";
    const rule = `golangci-lint(${linter})`;
    const severity: IssueSeverity =
      item.Severity?.toLowerCase() === "error" ? "error" : "warning";
    const message = normalizeIssueMessage(item.Text);
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
      serverName: "golangci-lint",
      sourceKind: "linter",
      provenance: createDiagnosticSource("linter", "external-lsp", "golangci-lint"),
    });
  }

  return issues;
}
