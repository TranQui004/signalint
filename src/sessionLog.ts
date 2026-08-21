export interface SessionLogMetrics {
  rawPayloadBytes: number;
  clusteredPayloadBytes: number;
  cacheHits: number;
  cacheMisses: number;
  latencyMs?: number;
}

export interface SessionLogWarning {
  signature: string;
}

export interface ParsedSessionLogEntry {
  timestamp?: number;
  activeSignatures?: string[];
  activeFileRulePairs?: string[];
  loopWarnings?: SessionLogWarning[];
  metrics?: SessionLogMetrics;
}

export interface ParsedSessionLog {
  entries: ParsedSessionLogEntry[];
  malformedLinesSkipped: number;
}

/** Parses independent JSONL records, skipping and counting malformed lines. */
export function parseSessionJsonLines(serialized: string): ParsedSessionLog {
  const entries: ParsedSessionLogEntry[] = [];
  let malformedLinesSkipped = 0;
  for (const line of serialized.split(/\r?\n/)) {
    if (line.trim() === "") {
      continue;
    }
    const entry = parseSessionLine(line);
    if (entry === undefined) {
      malformedLinesSkipped += 1;
    } else {
      entries.push(entry);
    }
  }
  return { entries, malformedLinesSkipped };
}

function parseSessionLine(line: string): ParsedSessionLogEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const entry: ParsedSessionLogEntry = {};
  if (parsed.timestamp !== undefined) {
    if (!Number.isInteger(parsed.timestamp)) {
      return undefined;
    }
    entry.timestamp = parsed.timestamp as number;
  }
  if (parsed.activeSignatures !== undefined) {
    if (
      !Array.isArray(parsed.activeSignatures) ||
      !parsed.activeSignatures.every((signature) => typeof signature === "string")
    ) {
      return undefined;
    }
    entry.activeSignatures = [...new Set(parsed.activeSignatures)];
  }
  if (parsed.activeFileRulePairs !== undefined) {
    if (
      !Array.isArray(parsed.activeFileRulePairs) ||
      !parsed.activeFileRulePairs.every((pair) => typeof pair === "string")
    ) {
      return undefined;
    }
    entry.activeFileRulePairs = [...new Set(parsed.activeFileRulePairs)];
  }
  if (parsed.loopWarnings !== undefined) {
    const warnings = parseWarnings(parsed.loopWarnings);
    if (warnings === undefined) {
      return undefined;
    }
    entry.loopWarnings = warnings;
  }
  if (parsed.metrics !== undefined) {
    const metrics = parseMetrics(parsed.metrics);
    if (metrics === undefined) {
      return undefined;
    }
    entry.metrics = metrics;
  }
  return entry;
}

function parseWarnings(value: unknown): SessionLogWarning[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const warnings: SessionLogWarning[] = [];
  for (const warning of value) {
    if (!isRecord(warning) || typeof warning.signature !== "string") {
      return undefined;
    }
    warnings.push({ signature: warning.signature });
  }
  return warnings;
}

function parseMetrics(value: unknown): SessionLogMetrics | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawPayloadBytes = readNonNegativeInteger(value.rawPayloadBytes);
  const clusteredPayloadBytes = readNonNegativeInteger(value.clusteredPayloadBytes);
  const cacheHits = readNonNegativeInteger(value.cacheHits);
  const cacheMisses = readNonNegativeInteger(value.cacheMisses);
  if (
    rawPayloadBytes === undefined ||
    clusteredPayloadBytes === undefined ||
    cacheHits === undefined ||
    cacheMisses === undefined
  ) {
    return undefined;
  }
  const metrics: SessionLogMetrics = {
    rawPayloadBytes,
    clusteredPayloadBytes,
    cacheHits,
    cacheMisses,
  };
  if (value.latencyMs !== undefined) {
    if (
      typeof value.latencyMs !== "number" ||
      !Number.isFinite(value.latencyMs) ||
      value.latencyMs < 0
    ) {
      return undefined;
    }
    metrics.latencyMs = value.latencyMs;
  }
  return metrics;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
