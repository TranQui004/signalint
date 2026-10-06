import { describe, expect, it } from "vitest";

import { parseSessionJsonLines } from "../src/memory/sessionLog.js";

describe("parseSessionJsonLines", () => {
  it("parses valid session log entries", () => {
    const raw = JSON.stringify({
      timestamp: 1234567890,
      activeSignatures: ["sig-1", "sig-2"],
      activeFileRulePairs: ["src/a.ts:rule-1"],
      loopWarnings: [{ signature: "sig-1" }],
      metrics: {
        rawPayloadBytes: 1000,
        clusteredPayloadBytes: 200,
        cacheHits: 5,
        cacheMisses: 1,
        latencyMs: 42.5,
      },
    });

    const parsed = parseSessionJsonLines(raw);
    expect(parsed.malformedLinesSkipped).toBe(0);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.timestamp).toBe(1234567890);
    expect(parsed.entries[0]?.activeSignatures).toEqual(["sig-1", "sig-2"]);
    expect(parsed.entries[0]?.metrics?.latencyMs).toBe(42.5);
  });

  it("skips and counts malformed or non-object lines", () => {
    const lines = [
      "not valid json",
      JSON.stringify({ timestamp: "not-a-number" }),
      JSON.stringify({ metrics: { rawPayloadBytes: -5 } }),
      JSON.stringify({ activeSignatures: ["sig-1"] }),
      "",
    ].join("\n");

    const parsed = parseSessionJsonLines(lines);
    expect(parsed.malformedLinesSkipped).toBe(3);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.activeSignatures).toEqual(["sig-1"]);
  });
});
