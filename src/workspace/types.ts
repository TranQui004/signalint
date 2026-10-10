/**
 * Defines data structures and contracts for workspace and monorepo graph resolution.
 */

export type MonorepoMode = "off" | "auto" | "strict";

export const MONOREPO_MODES: readonly MonorepoMode[] = ["off", "auto", "strict"];

/** Checks whether a value is a valid MonorepoMode setting. */
export function isMonorepoMode(value: unknown): value is MonorepoMode {
  return typeof value === "string" && (MONOREPO_MODES as readonly string[]).includes(value);
}

export interface WorkspacePackage {
  name: string;
  relativePath: string;
  absolutePath: string;
  manifestPath: string;
  version?: string | undefined;
  tsconfigPath?: string | undefined;
  dependencies: string[];
  tsReferences: string[];
}

export interface WorkspaceGraph {
  rootDir: string;
  packages: Map<string, WorkspacePackage>;
  topologicalOrder: string[];
  hasCycles: boolean;
  cycleNodes?: string[] | undefined;
}

export interface WorkspacePlan {
  targets: WorkspacePackage[];
  fallbackToRoot: boolean;
  fallbackReason?: string | undefined;
}
