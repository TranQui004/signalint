import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

import { readCanonicalProjectRootSync } from "../projectPaths.js";

export class HookPathError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HookPathError";
  }
}

const RELEVANT_CODE_EXTENSION_REGEX = /\.(?:[cm]?[jt]sx?|json|jsonc)$/i;

const TEMPORARY_OR_BACKUP_REGEX =
  /(?:^|[\\/])(?:\.~.*|.*~$|\.sw[a-p]$|\.tmp$|#.*#|\.bak$|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;

const EXCLUDED_DIRECTORY_SEGMENTS = new Set([
  ".git",
  ".signalint",
  "node_modules",
  ".claude",
  ".cursor",
  ".vscode",
  ".gemini",
  "dist",
  "coverage",
]);

/** Validates and canonicalizes one hook-supplied path against the project root boundary. */
export function validateHookPath(rawPath: string, projectRoot: string): string {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new HookPathError("empty_path", "Hook path must be a non-empty string.");
  }
  const path = rawPath.trim();

  if (path.includes("\0")) {
    throw new HookPathError("nul_byte", "Hook path contains illegal NUL character.");
  }

  if (path.startsWith("-")) {
    throw new HookPathError("leading_dash", "Hook path begins with a leading dash.");
  }

  const segments = path.split(/[\\/]+/);
  if (segments.includes("..")) {
    throw new HookPathError(
      "directory_traversal",
      `Hook path contains traversal segment '..': ${path}`,
    );
  }

  const canonicalRoot = readCanonicalProjectRootSync(projectRoot);
  const resolved = isAbsolute(path) ? resolve(path) : resolve(canonicalRoot, path);

  // If path exists on disk, canonicalize it before checking containment
  // to avoid false positives on Windows short (8.3) vs long path aliases.
  if (existsSync(resolved)) {
    let canonicalFile: string;
    try {
      canonicalFile = realpathSync.native ? realpathSync.native(resolved) : realpathSync(resolved);
    } catch {
      canonicalFile = realpathSync(resolved);
    }

    const realRel = relative(canonicalRoot, canonicalFile);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      const isRelativeInside = !isAbsolute(path);
      const isSymlink = (() => {
        try {
          return lstatSync(resolved).isSymbolicLink();
        } catch {
          return false;
        }
      })();

      if (isRelativeInside || isSymlink) {
        throw new HookPathError(
          "symlink_escape",
          `Hook path symlink escapes project root: ${path} -> ${canonicalFile}`,
        );
      }
      throw new HookPathError(
        "path_outside_project",
        `Hook path points outside the canonical project root: ${path}`,
      );
    }
    return normalizeRelativePath(realRel);
  }

  const rel = relative(canonicalRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new HookPathError(
      "path_outside_project",
      `Hook path points outside the canonical project root: ${path}`,
    );
  }

  return normalizeRelativePath(rel);
}

/** Determines whether a normalized relative path is a non-temporary code or configuration file. */
export function isRelevantCodeFile(relativePath: string): boolean {
  const normalized = normalize(relativePath);
  const segments = normalized.split(sep);

  for (const segment of segments) {
    if (EXCLUDED_DIRECTORY_SEGMENTS.has(segment.toLowerCase())) {
      return false;
    }
  }

  if (TEMPORARY_OR_BACKUP_REGEX.test(normalized)) {
    return false;
  }

  return RELEVANT_CODE_EXTENSION_REGEX.test(normalized);
}

/** Validates raw paths and filters them down to safe, relevant, de-duplicated project files. */
export function normalizeHookPaths(
  rawPaths: readonly string[],
  projectRoot: string,
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of rawPaths) {
    const validated = validateHookPath(raw, projectRoot);
    if (isRelevantCodeFile(validated) && !seen.has(validated)) {
      seen.add(validated);
      result.push(validated);
    }
  }

  return result;
}

function normalizeRelativePath(rel: string): string {
  const normalized = normalize(rel).replace(/\\/g, "/");
  return normalized === "" ? "." : normalized;
}
