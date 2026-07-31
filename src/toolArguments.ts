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
  z.strictObject({ clusterId: z.string().min(1) }),
  z.strictObject({ issueId: z.string().min(1) }),
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
