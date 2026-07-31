import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatSessionStats,
  parseSessionLog,
  readSessionStats,
} from "../src/stats.js";

const SESSION_LOG = [
  {
    timestamp: 1,
    loopWarnings: [makeWarning("rule-a")],
    metrics: {
      rawPayloadBytes: 1000,
      clusteredPayloadBytes: 200,
      cacheHits: 8,
      cacheMisses: 2,
      latencyMs: 100,
    },
  },
  {
    timestamp: 2,
    loopWarnings: [makeWarning("rule-a"), makeWarning("rule-b")],
    metrics: {
      rawPayloadBytes: 500,
      clusteredPayloadBytes: 250,
      cacheHits: 2,
      cacheMisses: 3,
      latencyMs: 300,
    },
  },
  {
    timestamp: 3,
    loopWarnings: [makeWarning("rule-b")],
  },
].map((entry) => JSON.stringify(entry)).join("\n");

describe("session statistics", () => {
  it("aggregates payload, cache, and distinct loop-warning metrics", () => {
    const stats = parseSessionLog(SESSION_LOG);

    expect(stats).toEqual({
      checks: 3,
      payloadSamples: 2,
      averagePayloadReductionPercent: 65,
      cacheHits: 10,
      cacheMisses: 5,
      cacheHitRatePercent: 100 * (2 / 3),
      latencySamples: 2,
      averageLatencyMs: 200,
      maxLatencyMs: 300,
      loopWarningsTriggered: 2,
      malformedLinesSkipped: 0,
    });
    expect(formatSessionStats(stats)).toBe([
      "Signalint session stats",
      "Checks: 3",
      "Average payload reduction: 65.0% (2 measured checks)",
      "Engine-file cache hit rate: 66.7% (10 hits / 15 lookups)",
      "Average check latency: 200.0ms (2 measured checks)",
      "Max check latency: 300.0ms",
      "Loop warnings triggered: 2",
      "Malformed session lines skipped: 0",
    ].join("\n"));
  });

  it("returns an empty report when no session log exists", async () => {
    const stats = await readSessionStats(resolve(".signalint/test/missing-stats.jsonl"));

    expect(formatSessionStats(stats)).toContain("Average payload reduction: n/a");
    expect(formatSessionStats(stats)).toContain("Engine-file cache hit rate: n/a");
    expect(formatSessionStats(stats)).toContain("Average check latency: n/a");
  });

  it("skips malformed JSON and reports the count", () => {
    const stats = parseSessionLog('{"timestamp":1}\nnot-json\n{"timestamp":2}');

    expect(stats.checks).toBe(2);
    expect(stats.malformedLinesSkipped).toBe(1);
    expect(formatSessionStats(stats)).toContain("Malformed session lines skipped: 1");
  });
});

function makeWarning(signature: string): Record<string, unknown> {
  return {
    signature,
    occurrences: 2,
    hint: "Fixture loop warning",
  };
}
