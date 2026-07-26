import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";

const fixtureRoot = resolve(".signalint/test/stats-cli");

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixtureRoot, { force: true, recursive: true });
});

describe("signalint stats CLI", () => {
  it("reads the project session log and prints all required aggregates", async () => {
    const logPath = resolve(fixtureRoot, ".signalint", "session.jsonl");
    await mkdir(resolve(fixtureRoot, ".signalint"), { recursive: true });
    await writeFile(
      logPath,
      `${JSON.stringify({
        loopWarnings: [],
        metrics: {
          rawPayloadBytes: 100,
          clusteredPayloadBytes: 25,
          cacheHits: 3,
          cacheMisses: 1,
        },
      })}\n`,
      "utf8",
    );
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(runCli(["stats"], fixtureRoot)).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Average payload reduction: 75.0%"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Cache hit rate: 75.0%"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Loop warnings triggered: 0"),
    );
  });
});
