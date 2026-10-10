import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { MonorepoMode, WorkspacePackage } from "./types.js";
import { canonicalizePath } from "../projectPaths.js";
import { isRecord } from "../util/index.js";

const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".signalint",
  ".next",
  ".turbo",
  ".cache",
]);

export interface DiscoveryResult {
  packages: WorkspacePackage[];
  reason?: "no_workspace_file" | "malformed_workspace_yaml" | undefined;
}

interface PackageReadResult {
  pkg: WorkspacePackage;
  rawDeps: Map<string, string>;
}

/** Parses the package glob list from a pnpm-workspace.yaml document using YAML parser. */
export function parsePnpmWorkspaceYaml(content: string): string[] | undefined {
  if (content.trim() === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["packages"])) {
    return undefined;
  }
  const globs: string[] = [];
  for (const item of parsed["packages"]) {
    if (typeof item === "string" && item.trim().length > 0) {
      globs.push(item.trim());
    }
  }
  return globs.length > 0 ? globs : undefined;
}

/** Converts a monorepo workspace glob pattern to an equivalent regular expression. */
export function globPatternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  let regex = "^";
  let i = 0;
  while (i < normalized.length) {
    if (normalized.startsWith("/**/", i)) {
      regex += "(?:/|/.*/)";
      i += 4;
    } else if (normalized.startsWith("/**", i) && i + 3 === normalized.length) {
      regex += "(?:/.*)?";
      i += 3;
    } else if (normalized.startsWith("**/", i)) {
      regex += "(?:.*/)?";
      i += 3;
    } else if (normalized.startsWith("**", i)) {
      regex += ".*";
      i += 2;
    } else if (normalized[i] === "*") {
      regex += "[^/]*";
      i += 1;
    } else if (normalized[i] === "?") {
      regex += "[^/]";
      i += 1;
    } else {
      const char = normalized[i];
      if (char !== undefined) {
        regex += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
      }
      i += 1;
    }
  }
  return new RegExp(`${regex}$`);
}

/** Evaluates whether a relative path matches any exclusion glob pattern. */
export function isPathExcluded(relPath: string, excludePatterns: readonly string[]): boolean {
  if (excludePatterns.length === 0) {
    return false;
  }
  const normalized = relPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  for (const pattern of excludePatterns) {
    const rx = globPatternToRegExp(pattern);
    if (rx.test(normalized)) {
      return true;
    }
    const segments = normalized.split("/");
    let parent = "";
    for (let s = 0; s < segments.length - 1; s += 1) {
      parent = parent === "" ? segments[s]! : `${parent}/${segments[s]!}`;
      if (rx.test(parent)) {
        return true;
      }
    }
  }
  return false;
}

/** Checks whether a package dependency specifier targets a local workspace package. */
export function isLocalWorkspaceMatch(
  specifier: string,
  targetVersion: string | undefined,
): boolean {
  const trimmed = specifier.trim();
  if (
    trimmed.startsWith("workspace:") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("link:")
  ) {
    return true;
  }
  if (trimmed === "*") {
    return true;
  }
  if (targetVersion === undefined || targetVersion.trim() === "") {
    return false;
  }
  const cleanTarget = targetVersion.trim().replace(/^[v=]/, "");
  if (trimmed === targetVersion || trimmed === cleanTarget) {
    return true;
  }
  const cleanSpec = trimmed.replace(/^[v=~^]/, "").trim();
  if (cleanSpec === cleanTarget) {
    return true;
  }
  return matchesCompatibleMajorOrMinor(trimmed, cleanSpec, cleanTarget);
}

function matchesCompatibleMajorOrMinor(
  specifier: string,
  cleanSpec: string,
  cleanTarget: string,
): boolean {
  const targetParts = cleanTarget.split(".");
  const specParts = cleanSpec.split(".");
  if (specifier.startsWith("^")) {
    return (
      specParts[0] !== undefined &&
      targetParts[0] !== undefined &&
      specParts[0] === targetParts[0]
    );
  }
  if (specifier.startsWith("~")) {
    return (
      specParts[0] !== undefined &&
      targetParts[0] !== undefined &&
      specParts[0] === targetParts[0] &&
      specParts[1] === targetParts[1]
    );
  }
  return false;
}

/** Discovers all workspace packages matching pnpm-workspace.yaml globs. */
export async function discoverWorkspacePackages(
  rootDir: string,
  mode: MonorepoMode = "auto",
): Promise<DiscoveryResult> {
  const workspaceYamlPath = resolve(rootDir, "pnpm-workspace.yaml");
  if (!existsSync(workspaceYamlPath)) {
    if (mode === "strict") {
      throw new Error(`Strict monorepo mode: 'pnpm-workspace.yaml' was not found in ${rootDir}`);
    }
    return { packages: [], reason: "no_workspace_file" };
  }

  let yamlContent: string;
  try {
    yamlContent = await readFile(workspaceYamlPath, "utf8");
  } catch (error: unknown) {
    if (mode === "strict") {
      throw new Error(`Strict monorepo mode: failed to read ${workspaceYamlPath}: ${String(error)}`);
    }
    return { packages: [], reason: "malformed_workspace_yaml" };
  }

  const globs = parsePnpmWorkspaceYaml(yamlContent);
  if (globs === undefined || globs.length === 0) {
    if (mode === "strict") {
      throw new Error(`Strict monorepo mode: 'pnpm-workspace.yaml' in ${rootDir} is malformed or defines no packages.`);
    }
    return { packages: [], reason: "malformed_workspace_yaml" };
  }

  const packageDirs = await expandWorkspaceGlobs(rootDir, globs);
  const packages: WorkspacePackage[] = [];
  const rawDepsMap = new Map<string, Map<string, string>>();

  for (const pkgDir of packageDirs) {
    const result = await readWorkspacePackage(pkgDir, rootDir);
    if (result !== undefined) {
      packages.push(result.pkg);
      rawDepsMap.set(result.pkg.name, result.rawDeps);
    }
  }

  resolveInterPackageDependencies(packages, rawDepsMap);
  return { packages };
}

async function expandWorkspaceGlobs(
  rootDir: string,
  globs: readonly string[],
): Promise<string[]> {
  const { includePatterns, excludePatterns } = partitionWorkspaceGlobs(globs);
  if (includePatterns.length === 0) {
    return [];
  }

  const candidateDirs = new Set<string>();
  for (const pattern of includePatterns) {
    await collectPatternDirectories(rootDir, pattern, candidateDirs);
  }

  return await filterCandidatePackages(rootDir, candidateDirs, excludePatterns);
}

function partitionWorkspaceGlobs(globs: readonly string[]): {
  includePatterns: string[];
  excludePatterns: string[];
} {
  const includePatterns: string[] = [];
  const excludePatterns: string[] = [];
  for (const glob of globs) {
    const trimmed = glob.trim();
    if (trimmed.startsWith("!")) {
      const pattern = trimmed.slice(1).trim();
      if (pattern.length > 0) {
        excludePatterns.push(pattern);
      }
    } else if (trimmed.length > 0) {
      includePatterns.push(trimmed);
    }
  }
  return { includePatterns, excludePatterns };
}

async function collectPatternDirectories(
  rootDir: string,
  pattern: string,
  candidates: Set<string>,
): Promise<void> {
  const cleanPattern = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (cleanPattern.includes("**")) {
    const prefix = cleanPattern.split("**")[0] ?? "";
    const baseDir = resolve(rootDir, prefix.replace(/\/+$/, ""));
    if (existsSync(baseDir)) {
      await walkDirectories(baseDir, rootDir, globPatternToRegExp(cleanPattern), candidates);
    }
  } else if (cleanPattern.includes("*") || cleanPattern.includes("?")) {
    await matchPathSegments(cleanPattern.split("/"), 0, rootDir, candidates);
  } else {
    const exactDir = resolve(rootDir, cleanPattern);
    if (existsSync(exactDir)) {
      candidates.add(exactDir);
    }
  }
}

async function filterCandidatePackages(
  rootDir: string,
  candidateDirs: Set<string>,
  excludePatterns: readonly string[],
): Promise<string[]> {
  const canonicalRoot = canonicalizePath(rootDir);
  const matchedDirs: string[] = [];

  for (const dir of candidateDirs) {
    const canonicalDir = canonicalizePath(dir);
    const manifestPath = join(canonicalDir, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    if (!(await isValidPackageManifest(manifestPath))) {
      continue;
    }
    const relPath = relative(canonicalRoot, canonicalDir).replaceAll("\\", "/");
    if (isPathExcluded(relPath, excludePatterns)) {
      continue;
    }
    matchedDirs.push(canonicalDir);
  }

  return Array.from(new Set(matchedDirs)).sort();
}

async function isValidPackageManifest(manifestPath: string): Promise<boolean> {
  try {
    const content = await readFile(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) && typeof parsed["name"] === "string" && parsed["name"].trim().length > 0;
  } catch {
    return false;
  }
}

async function walkDirectories(
  currentDir: string,
  rootDir: string,
  patternRegex: RegExp,
  results: Set<string>,
): Promise<void> {
  try {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED_DIR_NAMES.has(entry.name)) {
        const fullPath = resolve(currentDir, entry.name);
        const relPath = relative(rootDir, fullPath).replaceAll("\\", "/");
        if (patternRegex.test(relPath)) {
          results.add(fullPath);
        }
        await walkDirectories(fullPath, rootDir, patternRegex, results);
      }
    }
  } catch {
    // Ignore unreadable directories
  }
}

async function matchPathSegments(
  segments: readonly string[],
  segmentIndex: number,
  currentDir: string,
  results: Set<string>,
): Promise<void> {
  if (segmentIndex >= segments.length) {
    results.add(currentDir);
    return;
  }
  const segment = segments[segmentIndex];
  if (segment === undefined) {
    return;
  }
  if (!segment.includes("*") && !segment.includes("?")) {
    const nextDir = resolve(currentDir, segment);
    if (existsSync(nextDir)) {
      await matchPathSegments(segments, segmentIndex + 1, nextDir, results);
    }
    return;
  }

  const segmentRegex = globPatternToRegExp(segment);
  try {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !IGNORED_DIR_NAMES.has(entry.name) && segmentRegex.test(entry.name)) {
        const nextDir = resolve(currentDir, entry.name);
        await matchPathSegments(segments, segmentIndex + 1, nextDir, results);
      }
    }
  } catch {
    // Ignore unreadable directories
  }
}

async function readWorkspacePackage(
  pkgDir: string,
  rootDir: string,
): Promise<PackageReadResult | undefined> {
  const canonicalRoot = canonicalizePath(rootDir);
  const canonicalPkgDir = canonicalizePath(pkgDir);
  const manifestPath = join(canonicalPkgDir, "package.json");
  if (!existsSync(manifestPath)) {
    return undefined;
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return undefined;
  }

  const name = typeof manifest["name"] === "string" ? manifest["name"].trim() : "";
  if (name === "") {
    return undefined;
  }

  const version = typeof manifest["version"] === "string" ? manifest["version"].trim() : undefined;
  const rel = relative(canonicalRoot, canonicalPkgDir).replaceAll("\\", "/");
  const tsconfigPath = join(canonicalPkgDir, "tsconfig.json");
  const hasTsconfig = existsSync(tsconfigPath);

  const rawDeps = extractPackageDependencyMap(manifest);
  const tsReferences = hasTsconfig ? await extractTsconfigReferences(tsconfigPath) : [];

  return {
    pkg: {
      name,
      relativePath: rel,
      absolutePath: canonicalPkgDir,
      manifestPath: canonicalizePath(manifestPath),
      version,
      ...(hasTsconfig ? { tsconfigPath: canonicalizePath(tsconfigPath) } : {}),
      dependencies: Array.from(rawDeps.keys()),
      tsReferences,
    },
    rawDeps,
  };
}

function extractPackageDependencyMap(manifest: Record<string, unknown>): Map<string, string> {
  const depMap = new Map<string, string>();
  const depSections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

  for (const section of depSections) {
    const deps = manifest[section];
    if (isRecord(deps)) {
      for (const [depName, specifier] of Object.entries(deps)) {
        if (typeof specifier === "string") {
          depMap.set(depName, specifier);
        }
      }
    }
  }

  return depMap;
}

async function extractTsconfigReferences(tsconfigPath: string): Promise<string[]> {
  try {
    const raw = await readFile(tsconfigPath, "utf8");
    const stripped = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "$1");
    const parsed: unknown = JSON.parse(stripped);
    if (!isRecord(parsed) || !Array.isArray(parsed["references"])) {
      return [];
    }
    const refs: string[] = [];
    for (const ref of parsed["references"]) {
      if (isRecord(ref) && typeof ref["path"] === "string") {
        refs.push(ref["path"]);
      }
    }
    return refs;
  } catch {
    return [];
  }
}

/** Resolves and filters inter-package workspace dependencies and TypeScript project references. */
export function resolveInterPackageDependencies(
  packages: WorkspacePackage[],
  rawDepsMap?: Map<string, Map<string, string>>,
): void {
  const nameSet = new Set(packages.map((p) => p.name));
  const packageMap = new Map(packages.map((p) => [p.name, p]));
  const pathMap = buildCanonicalPathMap(packages);

  for (const pkg of packages) {
    const rawDeps = rawDepsMap?.get(pkg.name);
    pkg.dependencies = pkg.dependencies.filter((dep) => {
      if (!nameSet.has(dep) || dep === pkg.name) {
        return false;
      }
      if (rawDeps !== undefined) {
        const specifier = rawDeps.get(dep);
        if (specifier !== undefined) {
          const targetPkg = packageMap.get(dep);
          return isLocalWorkspaceMatch(specifier, targetPkg?.version);
        }
      }
      return true;
    });

    pkg.tsReferences = resolveTsReferences(pkg, pathMap);
  }
}

function buildCanonicalPathMap(packages: readonly WorkspacePackage[]): Map<string, string> {
  const pathMap = new Map<string, string>();
  for (const pkg of packages) {
    const canonical = canonicalizePath(pkg.absolutePath);
    pathMap.set(canonical, pkg.name);
    pathMap.set(canonical.toLowerCase(), pkg.name);
    const norm = canonical.replaceAll("\\", "/");
    pathMap.set(norm, pkg.name);
    pathMap.set(norm.toLowerCase(), pkg.name);
  }
  return pathMap;
}

function resolveTsReferences(
  pkg: WorkspacePackage,
  pathMap: Map<string, string>,
): string[] {
  const resolvedTsRefs: string[] = [];
  for (const rawRef of pkg.tsReferences) {
    const targetAbs = resolve(pkg.absolutePath, rawRef);
    const targetCanonical = canonicalizePath(targetAbs);
    const targetDir =
      existsSync(targetCanonical) && !targetCanonical.endsWith(".json")
        ? targetCanonical
        : dirname(targetCanonical);
    const canonicalDir = canonicalizePath(targetDir);

    let matchedName = pathMap.get(canonicalDir) ?? pathMap.get(canonicalDir.toLowerCase());
    if (matchedName === undefined) {
      const normDir = canonicalDir.replaceAll("\\", "/");
      matchedName = pathMap.get(normDir) ?? pathMap.get(normDir.toLowerCase());
    }

    if (matchedName !== undefined && matchedName !== pkg.name && !resolvedTsRefs.includes(matchedName)) {
      resolvedTsRefs.push(matchedName);
    }
  }
  return resolvedTsRefs;
}
