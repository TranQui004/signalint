import type { WorkspaceGraph, WorkspacePackage } from "./types.js";

/** Builds a union dependency graph combining package manifests and TypeScript project references. */
export function buildWorkspaceGraph(
  rootDir: string,
  packages: readonly WorkspacePackage[],
): WorkspaceGraph {
  const packageMap = new Map<string, WorkspacePackage>();
  for (const pkg of packages) {
    packageMap.set(pkg.name, pkg);
  }

  // Build union dependencies: for each package, all packages it depends on
  const dependenciesMap = new Map<string, Set<string>>();
  const dependentsMap = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  for (const pkg of packages) {
    dependentsMap.set(pkg.name, new Set());
    const unionDeps = new Set<string>();
    for (const dep of [...pkg.dependencies, ...pkg.tsReferences]) {
      if (packageMap.has(dep) && dep !== pkg.name) {
        unionDeps.add(dep);
      }
    }
    dependenciesMap.set(pkg.name, unionDeps);
    inDegree.set(pkg.name, unionDeps.size);
  }

  for (const [pkgName, deps] of dependenciesMap) {
    for (const dep of deps) {
      dependentsMap.get(dep)?.add(pkgName);
    }
  }

  // Kahn's algorithm for topological sorting: dependencies before dependents
  const queue: string[] = [];
  for (const [pkgName, degree] of inDegree) {
    if (degree === 0) {
      queue.push(pkgName);
    }
  }
  queue.sort();

  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    topologicalOrder.push(current);

    const dependents = dependentsMap.get(current);
    if (dependents !== undefined) {
      for (const dependent of dependents) {
        const nextDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, nextDegree);
        if (nextDegree === 0) {
          queue.push(dependent);
          queue.sort();
        }
      }
    }
  }

  const hasCycles = topologicalOrder.length < packages.length;

  return {
    rootDir,
    packages: packageMap,
    topologicalOrder,
    hasCycles,
  };
}

/** Returns all transitive dependencies for a package in the workspace graph. */
export function getTransitiveDependencies(
  packageName: string,
  graph: WorkspaceGraph,
): WorkspacePackage[] {
  const visited = new Set<string>();
  const target = graph.packages.get(packageName);
  if (target === undefined) {
    return [];
  }

  const queue = [...target.dependencies, ...target.tsReferences];
  while (queue.length > 0) {
    const depName = queue.shift();
    if (depName === undefined || visited.has(depName)) {
      continue;
    }
    visited.add(depName);
    const depPkg = graph.packages.get(depName);
    if (depPkg !== undefined) {
      for (const nextDep of [...depPkg.dependencies, ...depPkg.tsReferences]) {
        if (!visited.has(nextDep)) {
          queue.push(nextDep);
        }
      }
    }
  }

  return Array.from(visited)
    .sort()
    .map((name) => graph.packages.get(name))
    .filter((pkg): pkg is WorkspacePackage => pkg !== undefined);
}
