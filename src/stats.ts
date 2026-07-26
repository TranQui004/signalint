import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface SessionStats {
  checks: number;
  payloadSamples: number;
  averagePayloadReductionPercent: number | null;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRatePercent: number | null;
  latencySamples: number;
  averageLatencyMs: number | null;
  maxLatencyMs: number | null;
  loopWarningsTriggered: number;
}

interface LogMetrics {
  rawPayloadBytes: number;
  clusteredPayloadBytes: number;
  cacheHits: number;
  cacheMisses: number;
  latencyMs?: number;
}

/** Reads a Signalint JSONL session log and returns aggregate dogfooding metrics. */
export async function readSessionStats(
  logPath: string = resolve(process.cwd(), ".signalint", "session.jsonl"),
): Promise<SessionStats> {
  try {
    return parseSessionLog(await readFile(logPath, "utf8"));
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return emptySessionStats();
    }
    throw error;
  }
}

/** Parses Signalint session JSONL and supports pre-metrics Phase 4 log entries. */
export function parseSessionLog(serialized: string): SessionStats {
  const reductions: number[] = [];
  const warnedSignatures = new Set<string>();
  const latencies: number[] = [];
  let checks = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const [index, line] of serialized.split(/\r?\n/).entries()) {
    if (line.trim() === "") {
      continue;
    }
    const entry = parseLogEntry(line, index + 1);
    checks += 1;
    addWarningSignatures(entry.loopWarnings, warnedSignatures, index + 1);
    const metrics = readMetrics(entry.metrics, index + 1);
    if (metrics === undefined) {
      continue;
    }
    cacheHits += metrics.cacheHits;
    cacheMisses += metrics.cacheMisses;
    if (metrics.latencyMs !== undefined) {
      latencies.push(metrics.latencyMs);
    }
    if (metrics.rawPayloadBytes > 0) {
      reductions.push(
        ((metrics.rawPayloadBytes - metrics.clusteredPayloadBytes) /
          metrics.rawPayloadBytes) *
          100,
      );
    }
  }

  return {
    checks,
    payloadSamples: reductions.length,
    averagePayloadReductionPercent: average(reductions),
    cacheHits,
    cacheMisses,
    cacheHitRatePercent: percentage(cacheHits, cacheHits + cacheMisses),
    latencySamples: latencies.length,
    averageLatencyMs: average(latencies),
    maxLatencyMs: latencies.length === 0 ? null : Math.max(...latencies),
    loopWarningsTriggered: warnedSignatures.size,
  };
}

/** Formats aggregate session statistics as stable human-readable CLI output. */
export function formatSessionStats(stats: SessionStats): string {
  const reduction = formatPercent(stats.averagePayloadReductionPercent);
  const hitRate = formatPercent(stats.cacheHitRatePercent);
  const lookups = stats.cacheHits + stats.cacheMisses;
  return [
    "Signalint session stats",
    `Checks: ${String(stats.checks)}`,
    `Average payload reduction: ${reduction} (${String(stats.payloadSamples)} measured checks)`,
    `Engine-file cache hit rate: ${hitRate} (${String(stats.cacheHits)} hits / ${String(lookups)} lookups)`,
    `Average check latency: ${formatDuration(stats.averageLatencyMs)} (${String(stats.latencySamples)} measured checks)`,
    `Max check latency: ${formatDuration(stats.maxLatencyMs)}`,
    `Loop warnings triggered: ${String(stats.loopWarningsTriggered)}`,
  ].join("\n");
}

function parseLogEntry(line: string, lineNumber: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Invalid session JSON on line ${String(lineNumber)}.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Session log line ${String(lineNumber)} must contain an object.`);
  }
  return parsed;
}

function readMetrics(value: unknown, lineNumber: number): LogMetrics | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Session metrics on line ${String(lineNumber)} must contain an object.`);
  }
  const metrics: LogMetrics = {
    rawPayloadBytes: readNonNegativeInteger(value, "rawPayloadBytes", lineNumber),
    clusteredPayloadBytes: readNonNegativeInteger(value, "clusteredPayloadBytes", lineNumber),
    cacheHits: readNonNegativeInteger(value, "cacheHits", lineNumber),
    cacheMisses: readNonNegativeInteger(value, "cacheMisses", lineNumber),
  };
  if (value.latencyMs !== undefined) {
    metrics.latencyMs = readNonNegativeNumber(value, "latencyMs", lineNumber);
  }
  return metrics;
}

function addWarningSignatures(
  value: unknown,
  signatures: Set<string>,
  lineNumber: number,
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Session loopWarnings on line ${String(lineNumber)} must be an array.`);
  }
  for (const warning of value) {
    if (!isRecord(warning) || typeof warning.signature !== "string") {
      throw new Error(`Session loop warning on line ${String(lineNumber)} is invalid.`);
    }
    signatures.add(warning.signature);
  }
}

function readNonNegativeInteger(
  record: Record<string, unknown>,
  key: keyof LogMetrics,
  lineNumber: number,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Session metric "${key}" on line ${String(lineNumber)} is invalid.`);
  }
  return value;
}

function readNonNegativeNumber(
  record: Record<string, unknown>,
  key: "latencyMs",
  lineNumber: number,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Session metric "${key}" on line ${String(lineNumber)} is invalid.`);
  }
  return value;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : (numerator / denominator) * 100;
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}%`;
}

function formatDuration(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(1)}ms`;
}

function emptySessionStats(): SessionStats {
  return {
    checks: 0,
    payloadSamples: 0,
    averagePayloadReductionPercent: null,
    cacheHits: 0,
    cacheMisses: 0,
    cacheHitRatePercent: null,
    latencySamples: 0,
    averageLatencyMs: null,
    maxLatencyMs: null,
    loopWarningsTriggered: 0,
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
