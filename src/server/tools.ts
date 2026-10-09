import type { McpPayloadMode } from "../config.js";
import { MAX_TOOL_PATHS } from "../projectPaths.js";
import {
  afterEditCheckOutputSchema,
  checkOutputSchema,
  compareDiagnosticsOutputSchema,
  getDiagnosticSnapshotOutputSchema,
  getIssueDetailOutputSchema,
  getLiveDiagnosticsOutputSchema,
  getLoopStatusOutputSchema,
  ingestDiagnosticsOutputSchema,
  pingOutputSchema,
  TOOL_ANNOTATIONS,
} from "./toolSchemas.js";

/** Creates tool declarations, omitting outputSchema when the payload mode does not emit structuredContent. */
export function createTools(mode: McpPayloadMode = "both") {
  const advertiseOutput = mode !== "text";
  return [
    {
      name: "ping",
      description: "Checks whether the Signalint MCP server is responsive. Read-only; returns the string \"pong\" with no side effects. Use this to verify the server is connected before running diagnostics. Invalid arguments return an error response; no authentication is required.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: pingOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: "check_project",
      description: "Runs and clusters Oxlint and TypeScript (and optionally Biome) lint and type diagnostics for one or more project paths. Read-only; no files are written or modified. Paths default to the project root (\".\") when omitted; paths must be relative and within the project directory — absolute paths or paths outside the root return an error response. Use this for a full project scan; use check_files instead for faster incremental checks after editing specific files. Each call re-runs all enabled engines with no caching.",
      inputSchema: {
        type: "object" as const,
        properties: {
          paths: {
            type: "array" as const,
            items: { type: "string" as const, minLength: 1 },
            maxItems: MAX_TOOL_PATHS,
          },
        },
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: checkOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: "check_files",
      description: "Runs Oxlint and TypeScript (and optionally Biome) lint and type diagnostics on a specific list of files, using per-engine content-hash caching to skip unchanged files. Read-only; no files are written or modified. Use this for incremental checks after editing specific files; use check_project for a full project scan. The files parameter expects relative file paths (not glob patterns) within the project directory — absolute paths or paths outside the root return an error response. Caching is file-content-hash-based: a file is re-checked only when its content or the engine's config file (e.g., .oxlintrc, tsconfig.json) has changed since the last call, not based on git status. TypeScript is a whole-program engine: it re-runs whenever any TypeScript file in the request has changed content.",
      inputSchema: {
        type: "object" as const,
        properties: {
          files: {
            type: "array" as const,
            items: { type: "string" as const, minLength: 1 },
            maxItems: MAX_TOOL_PATHS,
          },
        },
        required: ["files"],
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: checkOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: "get_issue_detail",
      description: "Returns the full issue list for either one cluster ID or one issue ID from the most recent check_project or check_files call. Read-only; no files are written or modified. Supply exactly one of clusterId or issueId — supplying both or neither returns an argument error. If the referenced cluster or issue no longer exists in the latest results (e.g., after re-running a check), returns a status: \"stale\" response instead of an error; call check_project or check_files again to refresh.",
      inputSchema: {
        type: "object" as const,
        properties: {
          clusterId: { type: "string" as const },
          issueId: { type: "string" as const },
          checkId: { type: "string" as const },
        },
        oneOf: [
          { required: ["clusterId"] },
          { required: ["issueId"] },
        ],
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: getIssueDetailOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: "get_loop_status",
      description: "Returns all diagnostic issue signatures currently flagged as looping (repeatedly appearing and disappearing) in this server session. Read-only; no files are written or modified. Loop history is accumulated across all check_project and check_files calls in this process lifetime, and is restored from .signalint/session.jsonl on startup. Takes no parameters. Use this to identify which diagnostics an agent is oscillating on; use check_project or check_files to run fresh diagnostics.",
      inputSchema: {
        type: "object" as const,
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: getLoopStatusOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: "get_diagnostic_snapshot",
      description: "Retrieves the immutable diagnostic snapshot recorded for a specific checkId. Read-only; no files are modified. Returns full metadata, engine statuses, clusters, remaining issues, and performance metrics for that check run.",
      inputSchema: {
        type: "object" as const,
        properties: {
          checkId: { type: "string" as const, minLength: 1 },
        },
        required: ["checkId"],
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: getDiagnosticSnapshotOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: "compare_diagnostics",
      description: "Computes a deterministic diagnostic delta between two checks (baselineCheckId and currentCheckId). Read-only; no files are modified. Identifies introduced errors, resolved errors, unchanged issues, and net error delta, resilient to line shifts.",
      inputSchema: {
        type: "object" as const,
        properties: {
          baselineCheckId: { type: "string" as const, minLength: 1 },
          currentCheckId: { type: "string" as const, minLength: 1 },
        },
        required: ["baselineCheckId", "currentCheckId"],
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: compareDiagnosticsOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: "after_edit_check",
      description: "Runs incremental diagnostics on specified edited files and computes a verification delta against an optional baselineCheckId. Read-only; no files are written or modified. Use this after modifying files to verify whether edits introduced or resolved diagnostics relative to the baseline check.",
      inputSchema: {
        type: "object" as const,
        properties: {
          files: {
            type: "array" as const,
            items: { type: "string" as const, minLength: 1 },
            maxItems: MAX_TOOL_PATHS,
          },
          baselineCheckId: { type: "string" as const, minLength: 1 },
        },
        required: ["files"],
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: afterEditCheckOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: "ingest_diagnostics",
      description: "Ingests external LSP diagnostics (e.g., from VS Code or language servers), normalizes them to Signalint's unified schema, updates the active diagnostic buffer, and records an immutable snapshot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: { type: "string" as const },
          serverName: { type: "string" as const },
          diagnostics: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                file: { type: "string" as const },
                range: {
                  type: "object" as const,
                  properties: {
                    start: {
                      type: "object" as const,
                      properties: {
                        line: { type: "integer" as const },
                        character: { type: "integer" as const },
                      },
                      required: ["line", "character"],
                      additionalProperties: false,
                    },
                    end: {
                      type: "object" as const,
                      properties: {
                        line: { type: "integer" as const },
                        character: { type: "integer" as const },
                      },
                      required: ["line", "character"],
                      additionalProperties: false,
                    },
                  },
                  required: ["start", "end"],
                  additionalProperties: false,
                },
                severity: { type: "integer" as const },
                code: {
                  oneOf: [
                    { type: "string" as const },
                    { type: "integer" as const },
                  ],
                },
                source: { type: "string" as const },
                message: { type: "string" as const },
              },
              required: ["file", "range", "message"],
              additionalProperties: false,
            },
          },
        },
        required: ["diagnostics"],
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: ingestDiagnosticsOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
    {
      name: "get_live_diagnostics",
      description: "Returns current bounded active diagnostics and clusters merged from both internal engines and ingested LSP sources, with clear provenance per issue.",
      inputSchema: {
        type: "object" as const,
        properties: {
          files: {
            type: "array" as const,
            items: { type: "string" as const, minLength: 1 },
            maxItems: MAX_TOOL_PATHS,
          },
          severity: {
            type: "string" as const,
            enum: ["error", "warning"] as const,
          },
        },
        additionalProperties: false,
      },
      ...(advertiseOutput ? { outputSchema: getLiveDiagnosticsOutputSchema } : {}),
      annotations: TOOL_ANNOTATIONS,
    },
  ];
}

export const tools = createTools("both");
