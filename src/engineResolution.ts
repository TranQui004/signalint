import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { IssueEngine } from "./schema.js";
import { isRecord } from "./util/index.js";

export interface ResolvedEngine {
  engine: IssueEngine;
  binPath: string;
  version: string;
  isProjectLocal: boolean;
}

import { ENGINE_REGISTRY, type EngineSpec } from "./engines/registry.js";

export type EnginePackageInfo = Pick<EngineSpec, "packageName" | "binRelativePath" | "bundledAvailable">;

export const ENGINE_INFO: Record<IssueEngine, EnginePackageInfo> = ENGINE_REGISTRY;

const resolutionCache = new Map<string, ResolvedEngine | null>();

/** Clears the engine resolution cache; used in test suites. */
export function clearEngineResolutionCache(): void {
  resolutionCache.clear();
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Resolves an engine binary and version from the project root first, falling back to bundled copies. */
export function resolveEngine(
  engine: IssueEngine,
  projectRoot: string = process.cwd(),
): ResolvedEngine | undefined {
  const canonicalRoot = safeRealpath(projectRoot);
  const cacheKey = `${engine}:${canonicalRoot}`;
  if (resolutionCache.has(cacheKey)) {
    const cached = resolutionCache.get(cacheKey);
    return cached ?? undefined;
  }

  const info = ENGINE_INFO[engine];
  const resolved = resolveProjectLocalEngine(engine, info, projectRoot) ??
    (info.bundledAvailable ? resolveBundledEngine(engine, info) : undefined);

  resolutionCache.set(cacheKey, resolved ?? null);
  return resolved;
}

/** Resolves the effective version string for an engine in the target project. */
export function resolveEngineVersion(
  engine: IssueEngine,
  projectRoot: string = process.cwd(),
): string {
  const resolved = resolveEngine(engine, projectRoot);
  return resolved?.version ?? "0.0.0";
}

function resolveProjectLocalEngine(
  engine: IssueEngine,
  info: EnginePackageInfo,
  projectRoot: string,
): ResolvedEngine | undefined {
  try {
    const canonicalRoot = safeRealpath(projectRoot);
    const projectRequire = createRequire(resolve(projectRoot, "package.json"));
    const packageJsonPath = projectRequire.resolve(`${info.packageName}/package.json`, {
      paths: [projectRoot],
    });
    const canonicalPkg = safeRealpath(packageJsonPath);
    const rel = relative(canonicalRoot, canonicalPkg);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return undefined;
    }
    const packageDir = dirname(packageJsonPath);
    const version = readVersionFromPackageJson(packageJsonPath);

    // Try standard binRelativePath first
    const standardBin = resolve(packageDir, info.binRelativePath);
    if (fileExists(standardBin)) {
      return {
        engine,
        binPath: standardBin,
        version,
        isProjectLocal: true,
      };
    }

    // Try resolving bin path from package.json bin field
    const binFromPkg = resolveBinFromPackageJson(packageJsonPath);
    if (binFromPkg !== undefined && fileExists(binFromPkg)) {
      return {
        engine,
        binPath: binFromPkg,
        version,
        isProjectLocal: true,
      };
    }

    // Try node_modules/.bin/<name>
    const dotBinName = engine === "tsc" ? "tsc" : info.packageName.replace(/^@.+?\//, "");
    const dotBinPath = resolve(projectRoot, "node_modules", ".bin", dotBinName);
    if (fileExists(dotBinPath)) {
      return {
        engine,
        binPath: dotBinPath,
        version,
        isProjectLocal: true,
      };
    }
  } catch {
    // Project local resolution failed, proceed to fallback
  }

  return undefined;
}

function resolveBundledEngine(
  engine: IssueEngine,
  info: EnginePackageInfo,
): ResolvedEngine | undefined {
  try {
    const localRequire = createRequire(import.meta.url);
    const packageJsonPath = localRequire.resolve(`${info.packageName}/package.json`);
    const packageDir = dirname(packageJsonPath);
    const version = readVersionFromPackageJson(packageJsonPath);
    const binPath = resolve(packageDir, info.binRelativePath);

    return {
      engine,
      binPath,
      version,
      isProjectLocal: false,
    };
  } catch {
    return undefined;
  }
}

function readVersionFromPackageJson(packageJsonPath: string): string {
  try {
    const content = readFileSync(packageJsonPath, "utf8");
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed) && typeof parsed.version === "string") {
      return parsed.version;
    }
  } catch {
    // ignore
  }
  return "0.0.0";
}

function resolveBinFromPackageJson(packageJsonPath: string): string | undefined {
  try {
    const content = readFileSync(packageJsonPath, "utf8");
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || parsed.bin === undefined) {
      return undefined;
    }
    const packageDir = dirname(packageJsonPath);
    if (typeof parsed.bin === "string") {
      return resolve(packageDir, parsed.bin);
    }
    if (isRecord(parsed.bin)) {
      const firstEntry = Object.values(parsed.bin)[0];
      if (typeof firstEntry === "string") {
        return resolve(packageDir, firstEntry);
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

function fileExists(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile();
  } catch {
    return false;
  }
}
