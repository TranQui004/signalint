import { createHash } from "node:crypto";

export type IssueEngine = "oxlint" | "tsc" | "biome";
export type IssueSeverity = "error" | "warning";

export interface NormalizedIssue {
  issueId: string;
  file: string;
  line: number;
  col: number;
  engine: IssueEngine;
  rule: string;
  severity: IssueSeverity;
  message: string;
  fixable: boolean;
  clusterId?: string;
}

/** Converts an engine message to the schema's single-line, approximately 120-character form. */
export function normalizeIssueMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

/** Creates the stable Section 7.1 issue hash from a normalized issue location and message template. */
export function createIssueId(
  file: string,
  rule: string,
  line: number,
  message: string,
): string {
  const messageTemplate = message.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "$1<value>$1");
  return createHash("sha256")
    .update(`${file}\0${rule}\0${line}\0${messageTemplate}`)
    .digest("hex");
}

/** Returns whether an unknown value exactly satisfies the Phase 1 Normalized Issue shape. */
export function isNormalizedIssue(value: unknown): value is NormalizedIssue {
  if (!isRecord(value)) {
    return false;
  }

  const keys = Object.keys(value);
  const requiredKeys = [
    "issueId",
    "file",
    "line",
    "col",
    "engine",
    "rule",
    "severity",
    "message",
    "fixable",
  ];
  const allowedKeys = new Set([...requiredKeys, "clusterId"]);

  return (
    requiredKeys.every((key) => key in value) &&
    keys.every((key) => allowedKeys.has(key)) &&
    typeof value.issueId === "string" &&
    typeof value.file === "string" &&
    Number.isInteger(value.line) &&
    Number.isInteger(value.col) &&
    isIssueEngine(value.engine) &&
    typeof value.rule === "string" &&
    (value.severity === "error" || value.severity === "warning") &&
    typeof value.message === "string" &&
    value.message.length <= 120 &&
    typeof value.fixable === "boolean" &&
    (value.clusterId === undefined || typeof value.clusterId === "string")
  );
}

function isIssueEngine(value: unknown): value is IssueEngine {
  return value === "oxlint" || value === "tsc" || value === "biome";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
