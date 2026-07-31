import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
const rotatedLogPath = resolve(".signalint/test/rotated-stats.jsonl");

afterEach(async () => {
  await rm(rotatedLogPath, { force: true });
  await rm(`${rotatedLogPath}.1`, { force: true });
});

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

  it("includes rotated metrics without double-counting the retained overlap", async () => {
    const first = createMetricLine(1, 100);
    const retained = createMetricLine(2, 200);
    const latest = createMetricLine(3, 300);
    await writeFile(`${rotatedLogPath}.1`, `${first}\n${retained}\n`, "utf8");
    await writeFile(rotatedLogPath, `${retained}\n${latest}\n`, "utf8");

    const stats = await readSessionStats(rotatedLogPath);

    expect(stats.checks).toBe(3);
    expect(stats.latencySamples).toBe(3);
    expect(stats.averageLatencyMs).toBe(200);
    expect(stats.maxLatencyMs).toBe(300);
  });

  it("skips malformed JSON and reports the count", () => {
    const stats = parseSessionLog('{"timestamp":1}\nnot-json\n{"timestamp":2}');

    expect(stats.checks).toBe(2);
    expect(stats.malformedLinesSkipped).toBe(1);
    expect(formatSessionStats(stats)).toContain("Malformed session lines skipped: 1");
  });

  it("computes the maximum across a large latency history without spreading it", () => {
    const entryCount = 150_000;
    const serialized = Array.from({ length: entryCount }, (_, latencyMs) =>
      JSON.stringify({
        metrics: {
          rawPayloadBytes: 1,
          clusteredPayloadBytes: 1,
          cacheHits: 0,
          cacheMisses: 0,
          latencyMs,
        },
      }),
    ).join("\n");

    const stats = parseSessionLog(serialized);

    expect(stats.latencySamples).toBe(entryCount);
    expect(stats.maxLatencyMs).toBe(entryCount - 1);
  }, 10_000);
});

function makeWarning(signature: string): Record<string, unknown> {
  return {
    signature,
    occurrences: 2,
    hint: "Fixture loop warning",
  };
}

function createMetricLine(timestamp: number, latencyMs: number): string {
  return JSON.stringify({
    timestamp,
    metrics: {
      rawPayloadBytes: 100,
      clusteredPayloadBytes: 50,
      cacheHits: 1,
      cacheMisses: 0,
      latencyMs,
    },
  });
}
