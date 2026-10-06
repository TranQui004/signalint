#!/usr/bin/env node

import {
  checkConfiguredFiles,
  checkConfiguredFilesWithStats,
  checkProject,
  checkProjectWithIssues,
  collectProjectIssues,
  type IssueProviderResult,
} from "./check/checkProject.js";
import { runInitCommandSafely } from "./init.js";
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
  createServer,
  startServer,
  type IssueProvider,
  type IssueProviderResult,
  type SignalintServerOptions,
  type TestIssueProvider,
};

if (isMainModule(import.meta.url)) {
  if (process.argv[2] === "init") {
    if (process.argv.length > 3) {
      process.stderr.write("Usage: signalint-mcp init\n");
      process.exitCode = 2;
    } else {
      process.exitCode = await runInitCommandSafely();
    }
  } else {
    try {
      await startServer();
    } catch (error: unknown) {
      writeFatalError("server startup failed", error);
      process.exitCode = 1;
    }
  }
}
