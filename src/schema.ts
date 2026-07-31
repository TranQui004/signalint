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

export interface Cluster {
  clusterId: string;
  rootCauseSummary: string;
  ruleIds: string[];
  issueCount: number;
  fileCount: number;
  priority: number;
  suggestedAction: string;
  sampleIssueIds: string[];
}

export interface LoopWarning {
  signature: string;
  occurrences: number;
  hint: string;
}

export interface LoopStatus {
  looping: boolean;
  signatures: LoopWarning[];
}

export type EngineStatusKind = "ok" | "error" | "disabled";

export interface EngineStatus {
  status: EngineStatusKind;
  message?: string;
}

export type EngineStatuses = Record<IssueEngine, EngineStatus>;

export interface CheckResponse {
  schemaVersion: "1.1";
  status: "clean" | "issues_found";
  engines: EngineStatuses;
  totalIssues: number;
  clusters: Cluster[];
  truncated: boolean;
  loopWarning: LoopWarning | null;
}

export interface TimeoutResponse {
  status: "timeout";
  engine: IssueEngine;
  message: string;
}

export interface EngineOutputLimitResponse {
  status: "error";
  code: "engine_output_exceeded";
  engine: IssueEngine;
  message: string;
}

export interface StaleReferenceResponse {
  status: "stale";
  message: "This cluster/issue no longer exists; run check_project again.";
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

/** Returns whether an unknown value exactly satisfies the Phase 3 Check Response shape. */
export function isCheckResponse(value: unknown): value is CheckResponse {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === "1.1" &&
    (value.status === "clean" || value.status === "issues_found") &&
    isEngineStatuses(value.engines) &&
    Number.isInteger(value.totalIssues) &&
    Array.isArray(value.clusters) &&
    value.clusters.every(isCluster) &&
    typeof value.truncated === "boolean" &&
    (value.loopWarning === null || isLoopWarning(value.loopWarning))
  );
}

/** Creates an independent status map with every engine marked as successful. */
export function createSuccessfulEngineStatuses(): EngineStatuses {
  return {
    oxlint: { status: "ok" },
    tsc: { status: "ok" },
    biome: { status: "ok" },
  };
}

/** Returns whether an unknown value is the Section 8.1 engine-timeout response. */
export function isTimeoutResponse(value: unknown): value is TimeoutResponse {
  return (
    isRecord(value) &&
    value.status === "timeout" &&
    isIssueEngine(value.engine) &&
    typeof value.message === "string"
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
    value.signatures.every(isLoopWarning)
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
    typeof value.suggestedAction === "string" &&
    Array.isArray(value.sampleIssueIds) &&
    value.sampleIssueIds.every((issueId) => typeof issueId === "string")
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
  const expectedKeys = ["oxlint", "tsc", "biome"];
  return (
    isRecord(value) &&
    Object.keys(value).length === expectedKeys.length &&
    Object.keys(value).every((key) => expectedKeys.includes(key)) &&
    isEngineStatus(value.oxlint) &&
    isEngineStatus(value.tsc) &&
    isEngineStatus(value.biome)
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
  return value === "oxlint" || value === "tsc" || value === "biome";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
