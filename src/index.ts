#!/usr/bin/env node

import {
  checkConfiguredFiles,
  checkConfiguredFilesWithStats,
  checkProject,
  checkProjectWithIssues,
  collectProjectIssues,
  type IssueProviderResult,
} from "./check/checkProject.js";
import { writeFatalError } from "./lifecycle.js";
import { isMainModule } from "./mainModule.js";
import type { NormalizedIssue } from "./schema.js";
import {
  createServer,
  startServer,
  type SignalintServerOptions,
} from "./server/createServer.js";
import type {
  IssueProvider,
  TestIssueProvider,
} from "./server/context.js";
import {
  SnapshotStore,
  type DiagnosticSnapshot,
  type SnapshotStoreOptions,
} from "./diagnostics/snapshots.js";
import {
  computeDiagnosticDelta,
  type DiagnosticDelta,
} from "./diagnostics/delta.js";

export type RawIssueProvider = (
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<NormalizedIssue[]>;

export {
  checkConfiguredFiles,
  checkConfiguredFilesWithStats,
  checkProject,
  checkProjectWithIssues,
  collectProjectIssues,
  computeDiagnosticDelta,
  createServer,
  startServer,
  SnapshotStore,
  type DiagnosticDelta,
  type DiagnosticSnapshot,
  type IssueProvider,
  type IssueProviderResult,
  type SignalintServerOptions,
  type SnapshotStoreOptions,
  type TestIssueProvider,
};

export {
  runHookLauncher,
  type HookLauncherOptions,
  type HookLauncherResult,
} from "./hooks/launcher.js";
export {
  installHook,
  previewHookInstall,
  type HookInstallResult,
  type HookPreviewResult,
} from "./hooks/install.js";
export {
  type HookRuntime,
  type HookEventType,
  type NormalizedHookEvent,
  type HookDecision,
} from "./hooks/event.js";

export const CLI_VERBS: ReadonlySet<string> = new Set([
  "init",
  "check",
  "doctor",
  "stats",
  "hooks",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
]);

const INTERACTIVE_GUIDANCE =
  "signalint-mcp is the MCP server entry point: it speaks JSON-RPC over stdio and is\n" +
  "launched by an MCP client, not by hand. Use the `signalint` CLI for one-off commands:\n" +
  "  npx --yes -p signalint-mcp signalint doctor\n" +
  "  npm install -g signalint-mcp && signalint check .\n";

/** Dispatches CLI verbs or interactive guidance before starting the MCP stdio server; assumes process argv strings. */
export async function runEntrypoint(
  argv: readonly string[] = process.argv.slice(2),
  isTty: boolean = Boolean(process.stdin.isTTY),
): Promise<number | undefined> {
  const verb = argv[0];
  if (verb !== undefined && CLI_VERBS.has(verb)) {
    const { runCliSafely } = await import("./cli.js");
    return await runCliSafely(argv);
  }
  if (isTty) {
    process.stderr.write(INTERACTIVE_GUIDANCE);
    return 2;
  }
  try {
    await startServer();
  } catch (error: unknown) {
    writeFatalError("server startup failed", error);
    return 1;
  }
  return undefined;
}

if (isMainModule(import.meta.url)) {
  const exitCode = await runEntrypoint();
  if (exitCode !== undefined) {
    process.exitCode = exitCode;
  }
}
