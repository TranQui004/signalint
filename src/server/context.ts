import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { IssueProviderResult } from "../check/checkProject.js";
import { filterDefaultExcludedIssues } from "../check/exclusions.js";
import type { McpPayloadMode } from "../config.js";
import { resolveMcpPayloadMode } from "../config.js";
import { SessionMemory } from "../memory/sessionMemory.js";
import { resolveProjectPaths } from "../projectPaths.js";
import {
  createSuccessfulEngineStatuses,
  type NormalizedIssue,
} from "../schema.js";
import { isRecord } from "../util/index.js";
import { createTextResult } from "./errors.js";

import { SnapshotStore } from "../diagnostics/snapshots.js";

export type IssueProvider = (
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<IssueProviderResult>;

export type TestIssueProvider = (
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<NormalizedIssue[] | IssueProviderResult>;

export interface ToolHandlerContext {
  cwd: string;
  fileIssueProvider: IssueProvider;
  projectIssueProvider: IssueProvider;
  sessionMemory: SessionMemory;
  payloadMode: McpPayloadMode;
  snapshotStore: SnapshotStore;
  latestIssues?: NormalizedIssue[];
  latestCheckId?: string | undefined;
}

/** Resolves tool paths to relative paths safe within the project root. */
export async function resolveToolPaths(paths: readonly string[], cwd: string): Promise<string[]> {
  return (await resolveProjectPaths(paths, cwd)).map((path) => path.relativePath);
}

/** Normalizes a raw issue provider or structured issue provider for uniform server dispatch. */
export function wrapIssueProvider(
  provider: TestIssueProvider,
): IssueProvider {
  return async (paths, signal) => {
    const result = await provider(paths, signal);
    if (isRecord(result) && "engines" in result && "issues" in result) {
      const providerResult = result as IssueProviderResult;
      return {
        ...providerResult,
        issues: filterDefaultExcludedIssues(providerResult.issues),
      };
    }
    return {
      issues: filterDefaultExcludedIssues(result as NormalizedIssue[]),
      cache: { hits: 0, misses: 0 },
      engines: createSuccessfulEngineStatuses(),
    };
  };
}

/** Verifies that a project is initialized and has JS/TS markers before checking it. */
export async function checkProjectSafety(
  projectRoot: string,
  mode: McpPayloadMode = resolveMcpPayloadMode(),
): Promise<CallToolResult | undefined> {
  let hasConfigFile = false;
  try {
    await stat(resolve(projectRoot, "signalint.config.json"));
    hasConfigFile = true;
  } catch {
    hasConfigFile = false;
  }

  if (!hasConfigFile && process.env.SIGNALINT_ALLOW_UNINITIALIZED !== "1") {
    return {
      ...createTextResult(
        {
          status: "error",
          code: "project_not_initialized",
          message: `Run 'npx signalint-mcp init' in ${projectRoot} before checking it.`,
          projectRoot,
        },
        mode,
      ),
      isError: true,
    };
  }

  const isJs = await hasJsProjectMarkers(projectRoot);
  if (!isJs) {
    return {
      ...createTextResult(
        {
          status: "error",
          code: "not_a_js_project",
          message: `No JavaScript or TypeScript project markers found in ${projectRoot}.`,
          projectRoot,
        },
        mode,
      ),
      isError: true,
    };
  }

  return undefined;
}

async function hasJsProjectMarkers(projectRoot: string): Promise<boolean> {
  try {
    const rootEntries = await readdir(projectRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile()) {
        const name = entry.name.toLowerCase();
        if (name === "package.json" || name === "tsconfig.json") {
          return true;
        }
        if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i.test(name)) {
          return true;
        }
      }
    }

    let count = rootEntries.length;
    const queue: string[] = [];
    for (const entry of rootEntries) {
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        queue.push(resolve(projectRoot, entry.name));
      }
    }

    while (queue.length > 0 && count < 2000) {
      const currentDir = queue.shift();
      if (!currentDir) {
        break;
      }
      let subEntries;
      try {
        subEntries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of subEntries) {
        count++;
        if (entry.isFile()) {
          if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i.test(entry.name)) {
            return true;
          }
        } else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
          queue.push(resolve(currentDir, entry.name));
        }
        if (count >= 2000) {
          break;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}
