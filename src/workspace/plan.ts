import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, normalize, resolve } from "node:path";
import type { MonorepoMode, WorkspaceGraph, WorkspacePackage, WorkspacePlan } from "./types.js";
import { canonicalizePath } from "../projectPaths.js";
import { isRecord } from "../util/index.js";

export interface PlanOptions {
  mode?: MonorepoMode | undefined;
  targetFiles?: readonly string[] | undefined;
}

/** Plans the topological verification sequence across workspace packages, or falls back to root check. */
export function planWorkspaceChecks(
  graph: WorkspaceGraph,
  options: PlanOptions = {},
): WorkspacePlan {
  const mode = options.mode ?? "auto";
  if (mode === "off") {
    return { targets: [], fallbackToRoot: true, fallbackReason: "monorepo_disabled" };
  }

  if (graph.packages.size === 0) {
    return { targets: [], fallbackToRoot: true, fallbackReason: "no_workspace_packages" };
  }

  if (graph.hasCycles) {
    if (mode === "strict") {
      const cycleList = graph.cycleNodes?.join(", ") ?? "unknown";
      throw new Error(
        `Strict monorepo mode: dependency cycle detected between workspace packages (${cycleList}).`,
      );
    }
    return { targets: [], fallbackToRoot: true, fallbackReason: "dependency_cycle_detected" };
  }

  const targetFiles = options.targetFiles;
  if (targetFiles === undefined || targetFiles.length === 0 || targetFiles.includes(".")) {
    const allTargets = graph.topologicalOrder
      .map((name) => graph.packages.get(name))
      .filter((pkg): pkg is WorkspacePackage => pkg !== undefined);
    return { targets: allTargets, fallbackToRoot: false };
  }

  const directlyAffected = new Set<string>();
  for (const rawFile of targetFiles) {
    const normalizedFile = normalize(rawFile).replace(/\\/g, "/");
    const matchedPackage = findPackageForFile(normalizedFile, graph.packages);
    if (matchedPackage === undefined) {
      // Changed file is at repository root, which affects whole root check
      return { targets: [], fallbackToRoot: true, fallbackReason: "root_configuration_changed" };
    }
    directlyAffected.add(matchedPackage.name);
  }

  if (directlyAffected.size === 0) {
    return { targets: [], fallbackToRoot: true, fallbackReason: "no_matching_packages" };
  }

  // Compute transitive dependents closure: if B is changed, packages depending on B must also be checked
  const allAffected = computeTransitiveDependents(directlyAffected, graph);

  const orderedTargets = graph.topologicalOrder
    .filter((name) => allAffected.has(name))
    .map((name) => graph.packages.get(name))
    .filter((pkg): pkg is WorkspacePackage => pkg !== undefined);

  return { targets: orderedTargets, fallbackToRoot: false };
}

/** Finds the most specific workspace package that contains the given relative file path. */
export function findPackageForFile(
  filePath: string,
  packages: Map<string, WorkspacePackage>,
): WorkspacePackage | undefined {
  let matched: WorkspacePackage | undefined;
  let longestPrefixLength = -1;

  for (const pkg of packages.values()) {
    const pkgRel = pkg.relativePath;
    if (
      filePath === pkgRel ||
      filePath.startsWith(`${pkgRel}/`)
    ) {
      if (pkgRel.length > longestPrefixLength) {
        matched = pkg;
        longestPrefixLength = pkgRel.length;
      }
    }
  }

  return matched;
}

function computeTransitiveDependents(
  roots: Set<string>,
  graph: WorkspaceGraph,
): Set<string> {
  const result = new Set<string>(roots);
  const queue = Array.from(roots);

  // Map each package to packages that depend on it
  const dependentsMap = new Map<string, Set<string>>();
  for (const pkg of graph.packages.values()) {
    const unionDeps = [...pkg.dependencies, ...pkg.tsReferences];
    for (const dep of unionDeps) {
      let set = dependentsMap.get(dep);
      if (set === undefined) {
        set = new Set();
        dependentsMap.set(dep, set);
      }
      set.add(pkg.name);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const directDependents = dependentsMap.get(current);
    if (directDependents !== undefined) {
      for (const dep of directDependents) {
        if (!result.has(dep)) {
          result.add(dep);
          queue.push(dep);
        }
      }
    }
  }

  return result;
}

/** Checks whether root tsconfig exists and references all discovered packages. */
export async function hasSolutionStyleTsconfig(
  cwd: string,
  packages: readonly WorkspacePackage[],
): Promise<boolean> {
  const rootTsconfig = resolve(cwd, "tsconfig.json");
  if (!existsSync(rootTsconfig) || packages.length === 0) {
    return false;
  }
  try {
    const raw = await readFile(rootTsconfig, "utf8");
    const stripped = raw.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "$1");
    const parsed: unknown = JSON.parse(stripped);
    if (!isRecord(parsed) || !Array.isArray(parsed.references) || parsed.references.length === 0) {
      return false;
    }
    const refPaths = new Set<string>();
    const canonicalRefs = new Set<string>();

    for (const ref of parsed.references) {
      if (isRecord(ref) && typeof ref.path === "string") {
        const normRef = ref.path.replaceAll("\\", "/").replace(/\/tsconfig\.json$/, "");
        refPaths.add(normRef);
        refPaths.add(normRef.replace(/^\.\//, ""));
        try {
          const refAbs = resolve(cwd, ref.path);
          const refCanon = canonicalizePath(
            existsSync(refAbs) && !refAbs.endsWith(".json") ? refAbs : dirname(refAbs),
          );
          canonicalRefs.add(refCanon);
          canonicalRefs.add(refCanon.toLowerCase());
        } catch {
          // ignore unresolvable ref paths
        }
      }
    }

    for (const pkg of packages) {
      const rel = pkg.relativePath;
      const pkgCanonical = canonicalizePath(pkg.absolutePath);
      const hasRef =
        refPaths.has(rel) ||
        refPaths.has(`./${rel}`) ||
        refPaths.has(`${rel}/tsconfig.json`) ||
        refPaths.has(`./${rel}/tsconfig.json`) ||
        canonicalRefs.has(pkgCanonical) ||
        canonicalRefs.has(pkgCanonical.toLowerCase());
      if (!hasRef) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
