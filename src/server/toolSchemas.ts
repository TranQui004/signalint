import type { McpPayloadMode } from "../config.js";
import type { StaleReferenceResponse } from "../schema.js";

export const STALE_REFERENCE_RESPONSE: StaleReferenceResponse = {
  status: "stale",
  message: "This cluster/issue no longer exists; run check_project again.",
};

/** Resolves the output schema for an MCP tool, returning undefined when the mode suppresses structured content. */
export function resolveToolOutputSchema(
  schema: Record<string, unknown>,
  mode: McpPayloadMode = "both",
): Record<string, unknown> | undefined {
  return mode === "text" ? undefined : schema;
}

export const engineStatusOutputSchema = {
  type: "object" as const,
  properties: {
    status: {
      type: "string" as const,
      enum: ["ok", "error", "disabled"] as const,
    },
    message: { type: "string" as const },
  },
  required: ["status"],
  additionalProperties: false,
};

export const clusterOutputSchema = {
  type: "object" as const,
  properties: {
    clusterId: { type: "string" as const },
    rootCauseSummary: { type: "string" as const },
    ruleIds: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    issueCount: { type: "integer" as const },
    fileCount: { type: "integer" as const },
    priority: { type: "integer" as const },
    suggestedAction: { type: "string" as const },
    sampleIssueIds: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  required: [
    "clusterId",
    "rootCauseSummary",
    "ruleIds",
    "issueCount",
    "fileCount",
    "priority",
  ],
  additionalProperties: false,
};

export const remainingIssueOutputSchema = {
  type: "object" as const,
  properties: {
    issueId: { type: "string" as const },
    file: { type: "string" as const },
    line: { type: "integer" as const },
    col: { type: "integer" as const },
    rule: { type: "string" as const },
    severity: {
      type: "string" as const,
      enum: ["error", "warning"] as const,
    },
    fixable: { type: "boolean" as const },
    priority: { type: "integer" as const },
  },
  required: [
    "issueId",
    "file",
    "line",
    "col",
    "rule",
    "severity",
    "fixable",
  ],
  additionalProperties: false,
};

export const loopWarningOutputSchema = {
  type: "object" as const,
  properties: {
    signature: { type: "string" as const },
    occurrences: { type: "integer" as const },
    hint: { type: "string" as const },
  },
  required: ["signature", "occurrences", "hint"],
  additionalProperties: false,
};

export const fileRuleChurnWarningOutputSchema = {
  type: "object" as const,
  properties: {
    file: { type: "string" as const },
    rule: { type: "string" as const },
    checkCount: { type: "integer" as const },
    hint: { type: "string" as const },
  },
  required: ["file", "rule", "checkCount", "hint"],
  additionalProperties: false,
};

export const pingOutputSchema = {
  type: "object" as const,
  properties: {
    pong: {
      type: "boolean" as const,
      description: "True when the server is responsive.",
    },
    projectRoot: {
      type: "string" as const,
      description: "Canonical absolute project root path.",
    },
  },
  required: ["pong", "projectRoot"],
  additionalProperties: false,
};

export const checkOutputSchema = {
  type: "object" as const,
  properties: {
    schemaVersion: { type: "string" as const, enum: ["1.3", "1.4"] as const },
    status: {
      type: "string" as const,
      enum: ["clean", "issues_found", "error", "stale"] as const,
    },
    projectRoot: { type: "string" as const },
    engines: {
      type: "object" as const,
      properties: {
        oxlint: engineStatusOutputSchema,
        tsc: engineStatusOutputSchema,
        biome: engineStatusOutputSchema,
        eslint: engineStatusOutputSchema,
        "external-lsp": engineStatusOutputSchema,
        vscode: engineStatusOutputSchema,
      },
      additionalProperties: false,
    },
    totalIssues: { type: "integer" as const },
    clusters: {
      type: "array" as const,
      items: clusterOutputSchema,
    },
    remainingIssues: {
      type: "array" as const,
      items: remainingIssueOutputSchema,
    },
    omittedIssueCount: { type: "integer" as const },
    filteredOutIssueCount: { type: "integer" as const },
    filteredOutCount: { type: "integer" as const },
    filteredOut: { type: "integer" as const },
    nextStep: { type: "string" as const },
    truncated: { type: "boolean" as const },
    loopWarning: {
      oneOf: [
        loopWarningOutputSchema,
        { type: "null" as const },
      ],
    },
    fileRuleChurnWarning: {
      oneOf: [
        fileRuleChurnWarningOutputSchema,
        { type: "null" as const },
      ],
    },
    engine: {
      type: "string" as const,
      enum: ["oxlint", "tsc", "biome", "eslint"] as const,
    },
    checkId: { type: "string" as const },
    code: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["status"],
  additionalProperties: false,
};

export const normalizedIssueOutputSchema = {
  type: "object" as const,
  properties: {
    issueId: { type: "string" as const },
    file: { type: "string" as const },
    line: { type: "integer" as const },
    col: { type: "integer" as const },
    engine: {
      type: "string" as const,
      enum: [
        "oxlint",
        "tsc",
        "biome",
        "eslint",
        "external-lsp",
        "vscode",
      ] as const,
    },
    rule: { type: "string" as const },
    severity: {
      type: "string" as const,
      enum: ["error", "warning"] as const,
    },
    message: { type: "string" as const },
    fixable: { type: "boolean" as const },
    clusterId: { type: "string" as const },
    serverName: { type: "string" as const },
    sourceKind: {
      type: "string" as const,
      enum: ["compiler", "linter", "lsp", "editor"] as const,
    },
  },
  required: [
    "issueId",
    "file",
    "line",
    "col",
    "engine",
    "rule",
    "severity",
    "message",
    "fixable",
  ],
  additionalProperties: false,
};

export const getIssueDetailOutputSchema = {
  type: "object" as const,
  properties: {
    issues: {
      type: "array" as const,
      items: normalizedIssueOutputSchema,
    },
    status: {
      type: "string" as const,
      enum: ["stale", "error"] as const,
    },
    code: { type: "string" as const },
    message: { type: "string" as const },
    projectRoot: { type: "string" as const },
  },
  additionalProperties: false,
};

export const getLoopStatusOutputSchema = {
  type: "object" as const,
  properties: {
    looping: { type: "boolean" as const },
    signatures: {
      type: "array" as const,
      items: loopWarningOutputSchema,
    },
    fileChurning: { type: "boolean" as const },
    fileRuleChurns: {
      type: "array" as const,
      items: fileRuleChurnWarningOutputSchema,
    },
  },
  required: ["looping", "signatures", "fileChurning", "fileRuleChurns"],
  additionalProperties: false,
};

export const diagnosticDeltaOutputSchema = {
  type: "object" as const,
  properties: {
    status: { type: "string" as const },
    baselineId: { type: "string" as const },
    currentId: { type: "string" as const },
    baselineCheckId: { type: "string" as const },
    currentCheckId: { type: "string" as const },
    errorsIntroduced: { type: "integer" as const },
    errorsResolved: { type: "integer" as const },
    netDelta: { type: "integer" as const },
    introducedIssues: {
      type: "array" as const,
      items: normalizedIssueOutputSchema,
    },
    resolvedIssues: {
      type: "array" as const,
      items: normalizedIssueOutputSchema,
    },
    unchangedIssues: {
      type: "array" as const,
      items: normalizedIssueOutputSchema,
    },
    nextStep: { type: "string" as const },
    code: { type: "string" as const },
    message: { type: "string" as const },
  },
  additionalProperties: false,
};

export const getDiagnosticSnapshotOutputSchema = {
  type: "object" as const,
  properties: {
    status: {
      type: "string" as const,
      enum: ["clean", "issues_found", "error", "stale"] as const,
    },
    checkId: { type: "string" as const },
    projectRoot: { type: "string" as const },
    timestamp: { type: "integer" as const },
    source: {
      type: "string" as const,
      enum: ["project", "files", "lsp"] as const,
    },
    durationMs: { type: "number" as const },
    engines: {
      type: "object" as const,
      properties: {
        oxlint: engineStatusOutputSchema,
        tsc: engineStatusOutputSchema,
        biome: engineStatusOutputSchema,
        eslint: engineStatusOutputSchema,
        "external-lsp": engineStatusOutputSchema,
        vscode: engineStatusOutputSchema,
      },
      additionalProperties: false,
    },
    totalIssues: { type: "integer" as const },
    clusters: {
      type: "array" as const,
      items: clusterOutputSchema,
    },
    remainingIssues: {
      type: "array" as const,
      items: remainingIssueOutputSchema,
    },
    omittedIssueCount: { type: "integer" as const },
    filteredOutIssueCount: { type: "integer" as const },
    cache: {
      type: "object" as const,
      properties: {
        hits: { type: "integer" as const },
        misses: { type: "integer" as const },
      },
      required: ["hits", "misses"],
      additionalProperties: false,
    },
    code: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["status"],
  additionalProperties: false,
};

export const compareDiagnosticsOutputSchema = {
  type: "object" as const,
  properties: {
    status: {
      type: "string" as const,
      enum: ["ok", "stale", "error"] as const,
    },
    baselineId: { type: "string" as const },
    currentId: { type: "string" as const },
    baselineCheckId: { type: "string" as const },
    currentCheckId: { type: "string" as const },
    errorsIntroduced: { type: "integer" as const },
    errorsResolved: { type: "integer" as const },
    netDelta: { type: "integer" as const },
    introducedIssues: {
      type: "array" as const,
      items: normalizedIssueOutputSchema,
    },
    resolvedIssues: {
      type: "array" as const,
      items: normalizedIssueOutputSchema,
    },
    unchangedIssues: {
      type: "array" as const,
      items: normalizedIssueOutputSchema,
    },
    nextStep: { type: "string" as const },
    code: { type: "string" as const },
    message: { type: "string" as const },
  },
  required: ["status"],
  additionalProperties: false,
};

export const afterEditCheckOutputSchema = {
  type: "object" as const,
  properties: {
    schemaVersion: { type: "string" as const, enum: ["1.3", "1.4"] as const },
    status: {
      type: "string" as const,
      enum: ["clean", "issues_found", "error", "stale"] as const,
    },
    projectRoot: { type: "string" as const },
    engines: {
      type: "object" as const,
      properties: {
        oxlint: engineStatusOutputSchema,
        tsc: engineStatusOutputSchema,
        biome: engineStatusOutputSchema,
        eslint: engineStatusOutputSchema,
        "external-lsp": engineStatusOutputSchema,
        vscode: engineStatusOutputSchema,
      },
      additionalProperties: false,
    },
    totalIssues: { type: "integer" as const },
    clusters: {
      type: "array" as const,
      items: clusterOutputSchema,
    },
    remainingIssues: {
      type: "array" as const,
      items: remainingIssueOutputSchema,
    },
    omittedIssueCount: { type: "integer" as const },
    filteredOutIssueCount: { type: "integer" as const },
    filteredOutCount: { type: "integer" as const },
    nextStep: { type: "string" as const },
    truncated: { type: "boolean" as const },
    loopWarning: {
      anyOf: [
        loopWarningOutputSchema,
        { type: "null" as const },
      ],
    },
    fileRuleChurnWarning: {
      anyOf: [
        fileRuleChurnWarningOutputSchema,
        { type: "null" as const },
      ],
    },
    checkId: { type: "string" as const },
    code: { type: "string" as const },
    message: { type: "string" as const },
    delta: diagnosticDeltaOutputSchema,
  },
  required: ["status"],
  additionalProperties: false,
};

export const ingestDiagnosticsOutputSchema = {
  type: "object" as const,
  properties: {
    snapshotId: { type: "string" as const },
    checkId: { type: "string" as const },
    totalIssues: { type: "integer" as const },
    clusters: {
      type: "array" as const,
      items: clusterOutputSchema,
    },
    remainingIssues: {
      type: "array" as const,
      items: remainingIssueOutputSchema,
    },
  },
  required: ["snapshotId", "totalIssues", "clusters"],
  additionalProperties: false,
};

export const getLiveDiagnosticsOutputSchema = {
  type: "object" as const,
  properties: {
    status: {
      type: "string" as const,
      enum: ["clean", "issues_found", "error"] as const,
    },
    totalIssues: { type: "integer" as const },
    clusters: {
      type: "array" as const,
      items: clusterOutputSchema,
    },
    remainingIssues: {
      type: "array" as const,
      items: remainingIssueOutputSchema,
    },
    issues: {
      type: "array" as const,
      items: normalizedIssueOutputSchema,
    },
  },
  required: ["status", "totalIssues", "clusters"],
  additionalProperties: false,
};

/** Hints applied uniformly to every tool: local-only reads, no external writes or network. */
export const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
