import type { McpPayloadMode } from "../config.js";
import { MAX_TOOL_PATHS } from "../projectPaths.js";
import {
  checkOutputSchema,
  getIssueDetailOutputSchema,
  getLoopStatusOutputSchema,
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
  ];
}

export const tools = createTools("both");
