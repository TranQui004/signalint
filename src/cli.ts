#!/usr/bin/env node

import { resolve } from "node:path";

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
    process.stdout.write("Usage: signalint <check [path ...] | stats>\n");
    return 0;
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
      `Unknown command: ${command}\nUsage: signalint <check [path ...] | stats>\n`,
    );
    return 2;
  }

  const response = await checkProject(paths.length === 0 ? ["."] : paths, cwd);
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  return response.status === "clean" ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
