import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export const MAX_TOOL_PATHS = 512;

export type ProjectPathErrorCode =
  | "invalid_path"
  | "path_not_found"
  | "path_outside_project"
  | "too_many_paths";

export interface ResolvedProjectPath {
  absolutePath: string;
  relativePath: string;
}

export class ProjectPathError extends Error {
  /** Creates a structured project-path refusal suitable for an MCP error response. */
  public constructor(
    public readonly code: ProjectPathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectPathError";
  }
}

/** Resolves client paths through one canonical project boundary and caps request fan-out. */
export async function resolveProjectPaths(
  paths: readonly string[],
  cwd: string,
): Promise<ResolvedProjectPath[]> {
  if (paths.length > MAX_TOOL_PATHS) {
    throw new ProjectPathError(
      "too_many_paths",
      `At most ${String(MAX_TOOL_PATHS)} paths may be checked in one call.`,
    );
  }
  const projectRoot = await readCanonicalProjectRoot(cwd);
  return await Promise.all(paths.map((path) => resolveInputPath(path, projectRoot)));
}

/** Resolves one client path and rejects absolute, option-like, missing, or escaping input. */
export async function resolveProjectPath(
  path: string,
  cwd: string,
): Promise<ResolvedProjectPath> {
  return await resolveInputPath(path, await readCanonicalProjectRoot(cwd));
}

/** Canonicalizes an internally-derived absolute path and enforces the project boundary. */
export async function containProjectPath(
  absolutePath: string,
  cwd: string,
): Promise<ResolvedProjectPath> {
  const projectRoot = await readCanonicalProjectRoot(cwd);
  assertContained(projectRoot, absolutePath);
  return await canonicalizeContainedPath(absolutePath, projectRoot);
}

async function readCanonicalProjectRoot(cwd: string): Promise<string> {
  try {
    return await realpath(resolve(cwd));
  } catch (error: unknown) {
    throw pathNotFoundError("Project root", error);
  }
}

async function resolveInputPath(
  path: string,
  projectRoot: string,
): Promise<ResolvedProjectPath> {
  const syntaxError = getProjectPathSyntaxError(path);
  if (syntaxError !== undefined) {
    throw syntaxError;
  }
  const lexicalPath = resolve(projectRoot, path);
  assertContained(projectRoot, lexicalPath);
  const resolvedPath = await canonicalizeContainedPath(lexicalPath, projectRoot);
  if (resolvedPath.relativePath.startsWith("-")) {
    throw new ProjectPathError("invalid_path", "Paths must not begin with '-'.");
  }
  return resolvedPath;
}

async function canonicalizeContainedPath(
  path: string,
  projectRoot: string,
): Promise<ResolvedProjectPath> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
  } catch (error: unknown) {
    throw pathNotFoundError("Requested path", error);
  }
  assertContained(projectRoot, canonicalPath);
  const relativePath = relative(projectRoot, canonicalPath);
  return {
    absolutePath: canonicalPath,
    relativePath: relativePath === "" ? "." : relativePath.replaceAll("\\", "/"),
  };
}

/** Returns a structured syntax refusal for unsafe client path text, or undefined when safe. */
export function getProjectPathSyntaxError(path: string): ProjectPathError | undefined {
  if (path.length === 0 || path.includes("\0")) {
    return new ProjectPathError(
      "invalid_path",
      "Paths must be non-empty and contain no NUL bytes.",
    );
  }
  if (path.startsWith("-")) {
    return new ProjectPathError("invalid_path", "Paths must not begin with '-'.");
  }
  if (isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    return new ProjectPathError("path_outside_project", "Absolute paths are not allowed.");
  }
  return undefined;
}

function assertContained(projectRoot: string, candidate: string): void {
  const relativePath = relative(projectRoot, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new ProjectPathError(
      "path_outside_project",
      "Requested path resolves outside the project root.",
    );
  }
}

function pathNotFoundError(label: string, error: unknown): ProjectPathError {
  if (isErrnoException(error) && error.code === "ENOENT") {
    return new ProjectPathError("path_not_found", `${label} does not exist.`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProjectPathError("invalid_path", `${label} could not be resolved: ${message}`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
