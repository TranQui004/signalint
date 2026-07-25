#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkProject } from "./index.js";

/** Runs the thin Signalint CLI and assumes arguments exclude the Node and script entries. */
export async function runCli(args: readonly string[]): Promise<number> {
  const [command, ...paths] = args;
  if (command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write("Usage: signalint check [path ...]\n");
    return 0;
  }
  if (command !== "check") {
    process.stderr.write(`Unknown command: ${command}\nUsage: signalint check [path ...]\n`);
    return 2;
  }

  const response = await checkProject(paths.length === 0 ? ["."] : paths);
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  return response.status === "clean" ? 0 : 1;
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  process.exitCode = await runCli(process.argv.slice(2));
}
