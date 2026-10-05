import { isAbsolute, relative, resolve } from "node:path";

import type { NormalizedIssue } from "../schema.js";

/** Returns whether an unknown value is a non-null object record (not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Orders issues deterministically by file, line, column, engine, and issueId. */
export function compareIssues(
  left: NormalizedIssue | undefined,
  right: NormalizedIssue | undefined,
): number {
  if (left === undefined || right === undefined) {
    return left === right ? 0 : left === undefined ? 1 : -1;
  }
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.col - right.col ||
    left.engine.localeCompare(right.engine) ||
    left.issueId.localeCompare(right.issueId)
  );
}

/** Converts absolute or relative file paths to forward-slash project-relative paths. */
export function normalizeFile(file: string, cwd: string): string {
  const absoluteFile = isAbsolute(file) ? file : resolve(cwd, file);
  return relative(cwd, absoluteFile).replaceAll("\\", "/");
}

/** Reads a string property from a record or returns a fallback. */
export function readString(
  record: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}
