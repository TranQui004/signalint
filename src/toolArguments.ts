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

