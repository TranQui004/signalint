import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { MonorepoMode, WorkspacePackage } from "./types.js";
import { isRecord } from "../util/index.js";

export interface DiscoveryResult {
  packages: WorkspacePackage[];
  reason?: "no_workspace_file" | "malformed_workspace_yaml" | undefined;
}

/** Parses the package glob list from a pnpm-workspace.yaml document. */
export function parsePnpmWorkspaceYaml(content: string): string[] | undefined {
  const lines = content.split(/\r?\n/);
  const globs: string[] = [];
  let inPackages = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (line.trim() === "") {
      continue;
    }

    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }

    if (inPackages) {
      const match = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
      if (match !== null && match[1] !== undefined) {
        globs.push(match[1].trim());
      } else if (!/^\s/.test(line)) {
        // Exited packages block
        break;
      }
    }
  }

  if (!inPackages || globs.length === 0) {
    return undefined;
  }
  return globs;
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

  for (const pkgDir of packageDirs) {
    const pkg = await readWorkspacePackage(pkgDir, rootDir);
    if (pkg !== undefined) {
      packages.push(pkg);
    }
  }

  resolveInterPackageDependencies(packages);
  return { packages };
}

async function expandWorkspaceGlobs(rootDir: string, globs: readonly string[]): Promise<string[]> {
  const matchedDirs = new Set<string>();

  for (const glob of globs) {
    if (glob.startsWith("!")) {
      continue;
    }
    const cleanGlob = glob.replace(/\\/g, "/");
    if (cleanGlob.endsWith("/*")) {
      const parentDir = resolve(rootDir, cleanGlob.slice(0, -2));
      if (!existsSync(parentDir)) {
        continue;
      }
      try {
        const entries = await readdir(parentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            matchedDirs.add(resolve(parentDir, entry.name));
          }
        }
      } catch {
        // ignore unreadable dirs
      }
    } else {
      const exactDir = resolve(rootDir, cleanGlob);
      if (existsSync(exactDir)) {
        matchedDirs.add(exactDir);
      }
    }
  }

  return Array.from(matchedDirs).sort();
}

async function readWorkspacePackage(
  pkgDir: string,
  rootDir: string,
): Promise<WorkspacePackage | undefined> {
  const manifestPath = join(pkgDir, "package.json");
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

  const rel = relative(rootDir, pkgDir).replace(/\\/g, "/");
  const tsconfigPath = join(pkgDir, "tsconfig.json");
  const hasTsconfig = existsSync(tsconfigPath);

  const rawDependencies = extractPackageDependencyNames(manifest);
  const tsReferences = hasTsconfig ? await extractTsconfigReferences(tsconfigPath) : [];

  return {
    name,
    relativePath: rel,
    absolutePath: pkgDir,
    manifestPath,
    ...(hasTsconfig ? { tsconfigPath } : {}),
    dependencies: rawDependencies,
    tsReferences,
  };
}

function extractPackageDependencyNames(manifest: Record<string, unknown>): string[] {
  const depNames: string[] = [];
  const depSections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

  for (const section of depSections) {
    const deps = manifest[section];
    if (isRecord(deps)) {
      for (const [depName, specifier] of Object.entries(deps)) {
        if (typeof specifier === "string" && specifier.startsWith("workspace:")) {
          depNames.push(depName);
        } else {
          depNames.push(depName);
        }
      }
    }
  }

  return Array.from(new Set(depNames));
}

async function extractTsconfigReferences(tsconfigPath: string): Promise<string[]> {
  try {
    const raw = await readFile(tsconfigPath, "utf8");
    // Strip simple JSON comments
    const stripped = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "$1");
    const parsed = JSON.parse(stripped);
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

function resolveInterPackageDependencies(packages: WorkspacePackage[]): void {
  const nameSet = new Set(packages.map((p) => p.name));
  const pathMap = new Map(packages.map((p) => [p.absolutePath, p.name]));

  for (const pkg of packages) {
    // Keep only dependencies that match known workspace package names
    pkg.dependencies = pkg.dependencies.filter((dep) => nameSet.has(dep) && dep !== pkg.name);

    // Resolve tsReferences (file/dir paths) to workspace package names
    const resolvedTsRefs: string[] = [];
    for (const rawRef of pkg.tsReferences) {
      const targetAbs = resolve(pkg.absolutePath, rawRef);
      const targetDir = existsSync(targetAbs) && !targetAbs.endsWith(".json")
        ? targetAbs
        : dirname(targetAbs);

      const matchedName = pathMap.get(targetDir);
      if (matchedName !== undefined && matchedName !== pkg.name && !resolvedTsRefs.includes(matchedName)) {
        resolvedTsRefs.push(matchedName);
      }
    }
    pkg.tsReferences = resolvedTsRefs;
  }
}
