import { createHash } from "node:crypto";

export type BuiltinEngine = "oxlint" | "tsc" | "biome" | "eslint";
export type IssueEngine =
  | BuiltinEngine
  | "external-lsp"
  | "vscode";
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
  serverName?: string;
  sourceKind?: "compiler" | "linter" | "lsp" | "editor";
  provenance?: {
    kind: "compiler" | "linter" | "lsp" | "editor";
    engine: IssueEngine;
    serverName?: string;
    timestamp: number;
  };
}

export interface Cluster {
  clusterId: string;
  rootCauseSummary: string;
  ruleIds: string[];
  issueCount: number;
  fileCount: number;
  priority: number;
  suggestedAction?: string;
  sampleIssueIds?: string[];
}

export interface RemainingIssue {
  issueId: string;
  file: string;
  line: number;
  col: number;
  rule: string;
  severity: IssueSeverity;
  fixable: boolean;
  priority?: number;
}

export interface LoopWarning {
  signature: string;
  occurrences: number;
  hint: string;
}

export interface FileRuleChurnWarning {
  file: string;
  rule: string;
  checkCount: number;
  hint: string;
}

export interface LoopStatus {
  looping: boolean;
  signatures: LoopWarning[];
  fileChurning: boolean;
  fileRuleChurns: FileRuleChurnWarning[];
}

export type EngineStatusKind = "ok" | "error" | "disabled";

export interface EngineStatus {
  status: EngineStatusKind;
  message?: string;
}

export type EngineStatuses = Partial<Record<IssueEngine, EngineStatus>>;

/**
 * `schemaVersion` moved from "1.0" to "1.1" to add per-engine `EngineStatus`.
 * `schemaVersion` moved from "1.1" to "1.2" to add `fileRuleChurnWarning`.
 * `schemaVersion` moved from "1.2" to "1.3" to support structured engine-output-limit.
 * `schemaVersion` moved from "1.3" to "1.4" to eliminate information loss
 * from the 10-cluster cap. Responses now list remaining issues in a flat,
 * compact `remainingIssues` array, cap them at 100 entries, report omitted
 * counts in `omittedIssueCount`, and route single-issue groups flat instead
 * of wrapping them in ~400-byte cluster envelopes.
 */
export interface CheckResponse {
  schemaVersion: "1.3" | "1.4";
  status: "clean" | "issues_found" | "error";
  projectRoot?: string;
  engines: EngineStatuses;
  totalIssues: number;
  clusters: Cluster[];
  remainingIssues?: RemainingIssue[];
  omittedIssueCount?: number;
  filteredOutIssueCount?: number;
  filteredOutCount?: number;
  nextStep?: string;
  truncated: boolean;
  loopWarning?: LoopWarning | null;
  fileRuleChurnWarning?: FileRuleChurnWarning | null;
  checkId?: string;
  code?: string;
  message?: string;
}

export interface CompactCheckResponse {
  v: "1.4";
  status: "clean" | "issues_found" | "error";
  projectRoot?: string;
  engines: EngineStatuses;
  total: number;
  clusters: Cluster[];
  remaining?: RemainingIssue[];
  omitted?: number;
  filteredOut?: number;
  filteredOutIssueCount?: number;
  filteredOutCount?: number;
  nextStep?: string;
  truncated: boolean;
  loopWarning?: LoopWarning | null;
  fileRuleChurnWarning?: FileRuleChurnWarning | null;
  checkId?: string;
  code?: string;
  message?: string;
}

export interface EngineOutputLimitResponse {
  status: "error";
  code: "engine_output_exceeded";
  engine: IssueEngine;
  message: string;
}

export interface StaleReferenceResponse {
  status: "stale";
  message: string;
  code?: string;
  projectRoot?: string;
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
  const allowedKeys = new Set([
    ...requiredKeys,
    "clusterId",
    "serverName",
    "sourceKind",
    "provenance",
  ]);

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
    (value.clusterId === undefined || typeof value.clusterId === "string") &&
    (value.serverName === undefined || typeof value.serverName === "string") &&
    (value.sourceKind === undefined ||
      value.sourceKind === "compiler" ||
      value.sourceKind === "linter" ||
      value.sourceKind === "lsp" ||
      value.sourceKind === "editor") &&
    (value.provenance === undefined ||
      (isRecord(value.provenance) &&
        typeof value.provenance.kind === "string" &&
        typeof value.provenance.timestamp === "number"))
  );
}

/** Returns whether an unknown value satisfies the compact flat remaining-issue shape. */
export function isRemainingIssue(value: unknown): value is RemainingIssue {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.issueId === "string" &&
    typeof value.file === "string" &&
    Number.isInteger(value.line) &&
    Number.isInteger(value.col) &&
    typeof value.rule === "string" &&
    (value.severity === "error" || value.severity === "warning") &&
    typeof value.fixable === "boolean" &&
    (value.priority === undefined || Number.isInteger(value.priority))
  );
}

/** Returns whether an unknown value satisfies the Check Response shape (1.3 or 1.4, full or compact). */
export function isCheckResponse(value: unknown): value is CheckResponse {
  if (!isRecord(value)) {
    return false;
  }
  const isV13OrV14 = value.schemaVersion === "1.3" || value.schemaVersion === "1.4";
  const isCompactV14 = value.v === "1.4";
  if (!isV13OrV14 && !isCompactV14) {
    return false;
  }
  const statusValid = value.status === "clean" || value.status === "issues_found" || value.status === "error";
  const rootValid = value.projectRoot === undefined || typeof value.projectRoot === "string";
  const total = isCompactV14 ? (value.total ?? value.totalIssues) : value.totalIssues;
  const remaining = isCompactV14 ? (value.remaining ?? value.remainingIssues) : value.remainingIssues;
  const omitted = isCompactV14 ? (value.omitted ?? value.omittedIssueCount) : value.omittedIssueCount;
  const filteredOut = isCompactV14
    ? (value.filteredOut ?? value.filteredOutIssueCount ?? value.filteredOutCount)
    : (value.filteredOutIssueCount ?? value.filteredOutCount ?? value.filteredOut);

  return (
    statusValid &&
    rootValid &&
    isEngineStatuses(value.engines) &&
    Number.isInteger(total) &&
    Array.isArray(value.clusters) &&
    value.clusters.every(isCluster) &&
    (remaining === undefined || (Array.isArray(remaining) && remaining.every(isRemainingIssue))) &&
    (omitted === undefined || Number.isInteger(omitted)) &&
    (filteredOut === undefined || Number.isInteger(filteredOut)) &&
    (value.nextStep === undefined || typeof value.nextStep === "string") &&
    typeof value.truncated === "boolean" &&
    (value.loopWarning === null || value.loopWarning === undefined || isLoopWarning(value.loopWarning)) &&
    (value.fileRuleChurnWarning === null || value.fileRuleChurnWarning === undefined || isFileRuleChurnWarning(value.fileRuleChurnWarning)) &&
    (value.checkId === undefined || typeof value.checkId === "string") &&
    (value.code === undefined || typeof value.code === "string") &&
    (value.message === undefined || typeof value.message === "string")
  );
}

/** Creates an independent status map with default enabled engines marked ok, and disabled marked disabled. */
export function createDefaultEngineStatuses(): EngineStatuses {
  return {
    oxlint: { status: "ok" },
    tsc: { status: "ok" },
    biome: { status: "disabled" },
    eslint: { status: "disabled" },
  };
}

/** Creates an independent status map with every engine marked as successful. */
export function createSuccessfulEngineStatuses(): EngineStatuses {
  return {
    oxlint: { status: "ok" },
    tsc: { status: "ok" },
    biome: { status: "ok" },
    eslint: { status: "ok" },
  };
}

/** Returns whether an unknown value satisfies the FileRuleChurnWarning shape. */
export function isFileRuleChurnWarning(value: unknown): value is FileRuleChurnWarning {
  return (
    isRecord(value) &&
    typeof value.file === "string" &&
    typeof value.rule === "string" &&
    Number.isInteger(value.checkCount) &&
    (value.checkCount as number) >= 1 &&
    typeof value.hint === "string"
  );
}

/** Returns whether an unknown value is the structured engine-output-limit response. */
export function isEngineOutputLimitResponse(
  value: unknown,
): value is EngineOutputLimitResponse {
  return (
    isRecord(value) &&
    value.status === "error" &&
    value.code === "engine_output_exceeded" &&
    isIssueEngine(value.engine) &&
    typeof value.message === "string"
  );
}

/** Returns whether an unknown value is the Section 8 stale-reference response. */
export function isStaleReferenceResponse(value: unknown): value is StaleReferenceResponse {
  return (
    isRecord(value) &&
    value.status === "stale" &&
    value.message === "This cluster/issue no longer exists; run check_project again."
  );
}

/** Returns whether an unknown value exactly satisfies the Phase 4 loop-status shape. */
export function isLoopStatus(value: unknown): value is LoopStatus {
  return (
    isRecord(value) &&
    typeof value.looping === "boolean" &&
    Array.isArray(value.signatures) &&
    value.signatures.every(isLoopWarning) &&
    typeof value.fileChurning === "boolean" &&
    Array.isArray(value.fileRuleChurns) &&
    value.fileRuleChurns.every(isFileRuleChurnWarning)
  );
}

function isCluster(value: unknown): value is Cluster {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.clusterId === "string" &&
    typeof value.rootCauseSummary === "string" &&
    Array.isArray(value.ruleIds) &&
    value.ruleIds.every((rule) => typeof rule === "string") &&
    Number.isInteger(value.issueCount) &&
    Number.isInteger(value.fileCount) &&
    Number.isInteger(value.priority) &&
    (value.suggestedAction === undefined || typeof value.suggestedAction === "string") &&
    (value.sampleIssueIds === undefined ||
      (Array.isArray(value.sampleIssueIds) &&
        value.sampleIssueIds.every((issueId) => typeof issueId === "string")))
  );
}

function isLoopWarning(value: unknown): value is LoopWarning {
  return (
    isRecord(value) &&
    typeof value.signature === "string" &&
    Number.isInteger(value.occurrences) &&
    typeof value.hint === "string"
  );
}

function isEngineStatuses(value: unknown): value is EngineStatuses {
  const allowedKeys = new Set([
    "oxlint",
    "tsc",
    "biome",
    "eslint",
    "external-lsp",
    "vscode",
  ]);
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return false;
  }
  return (
    keys.every((key) => allowedKeys.has(key)) &&
    Object.values(value).every(isEngineStatus)
  );
}

function isEngineStatus(value: unknown): value is EngineStatus {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.every((key) => key === "status" || key === "message") &&
    (value.status === "ok" || value.status === "error" || value.status === "disabled") &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function isIssueEngine(value: unknown): value is IssueEngine {
  return (
    value === "oxlint" ||
    value === "tsc" ||
    value === "biome" ||
    value === "eslint" ||
    value === "external-lsp" ||
    value === "vscode"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
