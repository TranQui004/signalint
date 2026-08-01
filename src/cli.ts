#!/usr/bin/env node

import { resolve } from "node:path";

import { runInitCommand } from "./init.js";
import { checkProject } from "./index.js";
import { isMainModule } from "./mainModule.js";
import { formatSessionStats, readSessionStats } from "./stats.js";

/** Runs the thin CLI for arguments excluding Node/script entries and a supplied project root. */
export async function runCli(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<number> {
  const [command, ...paths] = args;
  if (command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write("Usage: signalint <init | check [path ...] | stats>\n");
    return 0;
  }
  if (command === "init") {
    if (paths.length > 0) {
      process.stderr.write("Usage: signalint init\n");
      return 2;
    }
    return await runInitCommand({ cwd });
  }
  if (command === "stats") {
    if (paths.length > 0) {
      process.stderr.write("Usage: signalint stats\n");
      return 2;
    }
    process.stdout.write(
      `${formatSessionStats(await readSessionStats(resolve(cwd, ".signalint", "session.jsonl")))}\n`,
    );
    return 0;
  }
  if (command !== "check") {
    process.stderr.write(
      `Unknown command: ${command}\nUsage: signalint <init | check [path ...] | stats>\n`,
    );
    return 2;
  }

  const response = await checkProject(paths.length === 0 ? ["."] : paths, cwd);
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  return response.status === "clean" ? 0 : 1;
}

/** Runs the CLI with a concise stderr failure instead of an uncaught Node stack dump. */
export async function runCliSafely(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<number> {
  try {
    return await runCli(args, cwd);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[signalint] CLI failed: ${message}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCliSafely(process.argv.slice(2));
}
