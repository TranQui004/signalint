import { DEFAULT_CONFIG } from "../config.js";
import { EngineDisabledError } from "../engineFanout.js";
import { resolveEngine } from "../engineResolution.js";
import {
  createIssueId,
  normalizeIssueMessage,
  type IssueSeverity,
  type NormalizedIssue,
} from "../schema.js";
import {
  attributeEngineError,
  runEngineCommand,
  type CommandResult,
} from "../subprocess.js";
import { isRecord, normalizeFile } from "../util/index.js";

export interface BiomeRunOptions {
  cwd?: string | undefined;
  includeFormatter?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** Parses pinned Biome JSON reporter output into exact Normalized Issue objects. */
export function parseBiomeOutput(
  output: string,
  cwd: string = process.cwd(),
  includeFormatter: boolean = false,
): NormalizedIssue[] {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.diagnostics)) {
    throw new Error("Biome output did not contain a diagnostics array.");
  }
  const filtered = parsed.diagnostics.filter((diagnostic) => {
    if (!isRecord(diagnostic)) {
      return false;
    }
    if (!includeFormatter && diagnostic.category === "format") {
      return false;
    }
    return true;
  });
  return filtered.map((diagnostic) => normalizeBiomeDiagnostic(diagnostic, cwd));
}

/** Runs the pinned Biome check command for supplied paths and returns normalized diagnostics. */
export async function runBiome(
  paths: readonly string[],
  options: BiomeRunOptions = {},
): Promise<NormalizedIssue[]> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = resolveEngine("biome", cwd);
  if (resolved === undefined) {
    throw new EngineDisabledError(
      "biome",
      "Biome is not installed in this project. Install @biomejs/biome to enable it.",
    );
  }

  try {
    const result = await runBiomeProcess(resolved.binPath, paths, cwd, options);
    const issues = result.stdout.trim() === ""
      ? []
      : parseBiomeOutput(result.stdout, cwd, options.includeFormatter ?? false);
    if (result.exitCode !== 0 && issues.length === 0) {
      throw new Error(
        `Biome failed with exit code ${String(result.exitCode)}: ${result.stderr.trim()}`,
      );
    }
    return issues;
  } catch (error: unknown) {
    if (error instanceof EngineDisabledError) {
      throw error;
    }
    throw attributeEngineError("biome", error);
  }
}

function normalizeBiomeDiagnostic(diagnostic: unknown, cwd: string): NormalizedIssue {
  if (!isRecord(diagnostic)) {
    throw new Error("Biome returned a diagnostic that was not an object.");
  }
  const location = isRecord(diagnostic.location) ? diagnostic.location : {};
  const start = isRecord(location.start) ? location.start : {};
  const file = typeof location.path === "string" ? normalizeFile(location.path, cwd) : "";
  const line = typeof start.line === "number" && Number.isInteger(start.line) ? start.line : 1;
  const col = typeof start.column === "number" && Number.isInteger(start.column) ? start.column : 1;
  const rule = typeof diagnostic.category === "string" ? diagnostic.category : "unknown";
  const rawMessage = typeof diagnostic.message === "string" ? diagnostic.message : "";
  const { severity, message } = readSeverityAndMessage(diagnostic.severity, rawMessage);
  const fixable = isBiomeDiagnosticFixable(diagnostic);

  return {
    issueId: createIssueId(file, rule, line, message),
    file,
    line,
    col,
    engine: "biome",
    rule,
    severity,
    message,
    fixable,
  };
}

function readSeverityAndMessage(
  value: unknown,
  rawMessage: string,
): { severity: IssueSeverity; message: string } {
  if (value === "error") {
    return { severity: "error", message: normalizeIssueMessage(rawMessage) };
  }
  if (value === "warning" || value === "info") {
    return { severity: "warning", message: normalizeIssueMessage(rawMessage) };
  }
  if (value === "fatal") {
    return { severity: "error", message: normalizeIssueMessage(rawMessage) };
  }
  const prefix = `[${String(value)}] `;
  return {
    severity: "error",
    message: normalizeIssueMessage(`${prefix}${rawMessage}`),
  };
}

function isBiomeDiagnosticFixable(diagnostic: Record<string, unknown>): boolean {
  const advicesValue = diagnostic.advices;
  const list: unknown[] = Array.isArray(advicesValue)
    ? advicesValue
    : isRecord(advicesValue) && Array.isArray(advicesValue.advices)
      ? advicesValue.advices
      : [];

  return list.some((advice) => {
    if (!isRecord(advice)) {
      return false;
    }
    if (typeof advice.text === "string" && /safe fix/i.test(advice.text)) {
      return true;
    }
    if (typeof advice.message === "string" && /safe fix/i.test(advice.message)) {
      return true;
    }
    return false;
  });
}

async function runBiomeProcess(
  cliPath: string,
  paths: readonly string[],
  cwd: string,
  options: BiomeRunOptions,
): Promise<CommandResult> {
  return runEngineCommand(
    process.execPath,
    createBiomeCliArgs(cliPath, paths, options.includeFormatter ?? false),
    {
      cwd,
      engine: "biome",
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_CONFIG.timeoutsMs.biome,
    },
  );
}

/** Builds Biome argv with optional formatter suppression flags and an end-of-options separator. */
export function createBiomeCliArgs(
  cliPath: string,
  paths: readonly string[],
  includeFormatter: boolean = false,
): string[] {
  const args = [cliPath, "check", "--reporter=json"];
  if (!includeFormatter) {
    args.push(
      "--javascript-formatter-enabled=false",
      "--json-formatter-enabled=false",
      "--css-formatter-enabled=false",
      "--graphql-formatter-enabled=false",
    );
  }
  args.push("--", ...paths);
  return args;
}
