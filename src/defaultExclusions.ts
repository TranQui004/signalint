import type { NormalizedIssue } from "./schema.js";

/** Returns true for dependency paths that Signalint must never surface as diagnostics. */
export function isDefaultExcludedPath(file: string): boolean {
  return file
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment.toLowerCase() === "node_modules");
}

/** Removes dependency diagnostics from every engine regardless of user ignore configuration. */
export function filterDefaultExcludedIssues(
  issues: readonly NormalizedIssue[],
): NormalizedIssue[] {
  return issues.filter((issue) => !isDefaultExcludedPath(issue.file));
}
