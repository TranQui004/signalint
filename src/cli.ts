#!/usr/bin/env node

import { resolve } from "node:path";

import { runInitCommand } from "./init.js";
import { checkProjectWithIssues } from "./index.js";
import { isMainModule } from "./mainModule.js";
import type { CheckResponse, NormalizedIssue } from "./schema.js";
import { formatSessionStats, readSessionStats } from "./stats.js";

const CHECK_USAGE =
  "Usage: signalint check [path ...] [--format json|github] [--fail-on-priority <N>]\n";

interface ParsedCheckArgs {
  failOnPriority: number | undefined;
  format: "json" | "github";
  paths: string[];
}

/** Runs the thin CLI for arguments excluding Node/script entries and a supplied project root. */
export async function runCli(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<number> {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write("Usage: signalint <init | check [path ...] | stats>\n");
    return 0;
  }
  if (command === "init") {
    if (rest.length > 0) {
      process.stderr.write("Usage: signalint init\n");
      return 2;
    }
    return await runInitCommand({ cwd });
  }
  if (command === "stats") {
    if (rest.length > 0) {
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

  const parsed = parseCheckArgs(rest);
  if (parsed === undefined) {
    process.stderr.write(CHECK_USAGE);
    return 2;
  }

  const { issues, response } = await checkProjectWithIssues(
    parsed.paths.length === 0 ? ["."] : parsed.paths,
    cwd,
  );
  writeCheckOutput(parsed.format, issues, response);
  return shouldFailCheck(response, parsed.failOnPriority) ? 1 : 0;
}

/** Parses `check` flags and positional paths, or returns undefined for an invalid invocation. */
function parseCheckArgs(args: readonly string[]): ParsedCheckArgs | undefined {
  const paths: string[] = [];
  let format: "json" | "github" = "json";
  let failOnPriority: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--format") {
      const value = args[index + 1];
      if (value !== "json" && value !== "github") {
        return undefined;
      }
      format = value;
      index += 1;
      continue;
    }
    if (arg === "--fail-on-priority") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        return undefined;
      }
      failOnPriority = value;
      index += 1;
      continue;
    }
    if (arg !== undefined) {
      paths.push(arg);
    }
  }

  return { failOnPriority, format, paths };
}

/** Writes either the default JSON response or GitHub Actions annotations for each issue. */
function writeCheckOutput(
  format: "json" | "github",
  issues: readonly NormalizedIssue[],
  response: CheckResponse,
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }
  for (const issue of issues) {
    process.stdout.write(`${formatGithubAnnotation(issue)}\n`);
  }
}

/** Formats one issue as a GitHub Actions error/warning workflow-command annotation. */
function formatGithubAnnotation(issue: NormalizedIssue): string {
  const level = issue.severity === "error" ? "error" : "warning";
  const file = escapeWorkflowCommandProperty(issue.file);
  const message = escapeWorkflowCommandValue(`${issue.rule}: ${issue.message}`);
  return `::${level} file=${file},line=${String(issue.line)},col=${String(issue.col)}::${message}`;
}

function escapeWorkflowCommandValue(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeWorkflowCommandProperty(value: string): string {
  return escapeWorkflowCommandValue(value).replaceAll(",", "%2C").replaceAll(":", "%3A");
}

/** Returns whether `check` should exit non-zero, using the priority ladder from clusterEngine.ts. */
function shouldFailCheck(response: CheckResponse, failOnPriority: number | undefined): boolean {
  if (failOnPriority === undefined) {
    return response.status !== "clean";
  }
  return response.clusters.some((cluster) => cluster.priority <= failOnPriority);
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
