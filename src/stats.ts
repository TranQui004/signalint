import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseSessionJsonLines } from "./sessionLog.js";

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
  malformedLinesSkipped: number;
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
  const parsedLog = parseSessionJsonLines(serialized);
  const reductions: number[] = [];
  const warnedSignatures = new Set<string>();
  const latencies: number[] = [];
  let checks = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const entry of parsedLog.entries) {
    checks += 1;
    addWarningSignatures(entry.loopWarnings, warnedSignatures);
    const metrics = entry.metrics;
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
    malformedLinesSkipped: parsedLog.malformedLinesSkipped,
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
    `Malformed session lines skipped: ${String(stats.malformedLinesSkipped)}`,
  ].join("\n");
}

function addWarningSignatures(
  value: readonly { signature: string }[] | undefined,
  signatures: Set<string>,
): void {
  if (value === undefined) {
    return;
  }
  for (const warning of value) {
    signatures.add(warning.signature);
  }
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
    malformedLinesSkipped: 0,
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
