import { z } from "zod";

import { MAX_TOOL_PATHS } from "./projectPaths.js";

const projectPathsSchema = z.array(z.string()).max(MAX_TOOL_PATHS);
const emptyArgumentsSchema = z.strictObject({});
const checkProjectArgumentsSchema = z.strictObject({
  paths: projectPathsSchema.optional(),
});
const checkFilesArgumentsSchema = z.strictObject({
  files: projectPathsSchema,
});
const issueReferenceSchema = z.union([
  z.strictObject({
    clusterId: z.string().min(1),
    checkId: z.string().min(1).optional(),
  }),
  z.strictObject({
    issueId: z.string().min(1),
    checkId: z.string().min(1).optional(),
  }),
]);

export type IssueReference = z.infer<typeof issueReferenceSchema>;

/** Parses ping arguments and rejects unknown properties at runtime. */
export function parsePingArguments(argumentsValue: unknown): void {
  emptyArgumentsSchema.parse(argumentsValue ?? {});
}

/** Parses check_project arguments and defaults omitted paths to the project root. */
export function parseCheckProjectArguments(argumentsValue: unknown): string[] {
  const parsed = checkProjectArgumentsSchema.parse(argumentsValue ?? {});
  return parsed.paths ?? ["."];
}

/** Parses required check_files arguments with strict path syntax and request limits. */
export function parseCheckFilesArguments(argumentsValue: unknown): string[] {
  return checkFilesArgumentsSchema.parse(argumentsValue).files;
}

/** Parses exactly one non-empty clusterId or issueId reference. */
export function parseIssueReference(argumentsValue: unknown): IssueReference {
  return issueReferenceSchema.parse(argumentsValue);
}

/** Parses get_loop_status arguments and rejects unknown properties at runtime. */
export function parseLoopStatusArguments(argumentsValue: unknown): void {
  emptyArgumentsSchema.parse(argumentsValue ?? {});
}

const getDiagnosticSnapshotArgumentsSchema = z.strictObject({
  checkId: z.string().min(1),
});

/** Parses get_diagnostic_snapshot arguments and requires non-empty checkId. */
export function parseGetDiagnosticSnapshotArguments(argumentsValue: unknown): { checkId: string } {
  return getDiagnosticSnapshotArgumentsSchema.parse(argumentsValue);
}

const compareDiagnosticsArgumentsSchema = z.strictObject({
  baselineCheckId: z.string().min(1),
  currentCheckId: z.string().min(1),
});

/** Parses compare_diagnostics arguments and requires both baselineCheckId and currentCheckId. */
export function parseCompareDiagnosticsArguments(argumentsValue: unknown): {
  baselineCheckId: string;
  currentCheckId: string;
} {
  return compareDiagnosticsArgumentsSchema.parse(argumentsValue);
}

const afterEditCheckArgumentsSchema = z.strictObject({
  files: projectPathsSchema,
  baselineCheckId: z.string().min(1).optional(),
});

/** Parses after_edit_check arguments with required files and optional baselineCheckId. */
export function parseAfterEditCheckArguments(argumentsValue: unknown): {
  files: string[];
  baselineCheckId?: string | undefined;
} {
  return afterEditCheckArgumentsSchema.parse(argumentsValue);
}

const lspPositionSchema = z.strictObject({
  line: z.number().int(),
  character: z.number().int(),
});

const lspRangeSchema = z.strictObject({
  start: lspPositionSchema,
  end: lspPositionSchema,
});

const lspDiagnosticItemSchema = z.strictObject({
  file: z.string().min(1),
  range: lspRangeSchema,
  severity: z.number().int().optional(),
  code: z.union([z.string(), z.number()]).optional(),
  source: z.string().optional(),
  message: z.string(),
});

const ingestDiagnosticsArgumentsSchema = z.strictObject({
  source: z.string().optional(),
  serverName: z.string().optional(),
  diagnostics: z.array(lspDiagnosticItemSchema),
});

export type IngestDiagnosticsArguments = z.infer<typeof ingestDiagnosticsArgumentsSchema>;

/** Parses ingest_diagnostics arguments with closed schema and valid diagnostic positions. */
export function parseIngestDiagnosticsArguments(
  argumentsValue: unknown,
): IngestDiagnosticsArguments {
  return ingestDiagnosticsArgumentsSchema.parse(argumentsValue);
}

const getLiveDiagnosticsArgumentsSchema = z.strictObject({
  files: projectPathsSchema.optional(),
  severity: z.enum(["error", "warning"]).optional(),
});

export type GetLiveDiagnosticsArguments = z.infer<typeof getLiveDiagnosticsArgumentsSchema>;

/** Parses get_live_diagnostics arguments with optional file filter and severity filter. */
export function parseGetLiveDiagnosticsArguments(
  argumentsValue: unknown,
): GetLiveDiagnosticsArguments {
  return getLiveDiagnosticsArgumentsSchema.parse(argumentsValue ?? {});
}

const filePatchSchema = z.strictObject({
  file: z.string().min(1),
  originalContent: z.string(),
  patchedContent: z.string(),
  description: z.string().optional(),
});

const previewDiagnosticFixArgumentsSchema = z.strictObject({
  patches: z.array(filePatchSchema).min(1),
});

export type PreviewDiagnosticFixArguments = z.infer<typeof previewDiagnosticFixArgumentsSchema>;

/** Parses preview_diagnostic_fix arguments requiring non-empty patches list. */
export function parsePreviewDiagnosticFixArguments(
  argumentsValue: unknown,
): PreviewDiagnosticFixArguments {
  return previewDiagnosticFixArgumentsSchema.parse(argumentsValue);
}

const applyDiagnosticFixArgumentsSchema = z.strictObject({
  transactionId: z.string().min(1),
  confirm: z.boolean(),
});

export type ApplyDiagnosticFixArguments = z.infer<typeof applyDiagnosticFixArgumentsSchema>;

/** Parses apply_diagnostic_fix arguments requiring transactionId and boolean confirm. */
export function parseApplyDiagnosticFixArguments(
  argumentsValue: unknown,
): ApplyDiagnosticFixArguments {
  return applyDiagnosticFixArgumentsSchema.parse(argumentsValue);
}

const discardDiagnosticFixArgumentsSchema = z.strictObject({
  transactionId: z.string().min(1),
});

export type DiscardDiagnosticFixArguments = z.infer<typeof discardDiagnosticFixArgumentsSchema>;

/** Parses discard_diagnostic_fix arguments requiring transactionId. */
export function parseDiscardDiagnosticFixArguments(
  argumentsValue: unknown,
): DiscardDiagnosticFixArguments {
  return discardDiagnosticFixArgumentsSchema.parse(argumentsValue);
}


