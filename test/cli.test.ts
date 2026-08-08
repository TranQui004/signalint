import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, runCliSafely } from "../src/cli.js";

const fixtureRoot = resolve(".signalint/test/stats-cli");
const checkFixtureRoot = resolve("test/fixtures/cli-check-project");

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
          latencyMs: 40,
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
      expect.stringContaining("Engine-file cache hit rate: 75.0%"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Average check latency: 40.0ms"),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining("Loop warnings triggered: 0"),
    );
  });

  it("prints a concise stderr message for rejected check paths", async () => {
    await mkdir(fixtureRoot, { recursive: true });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(runCliSafely(["check", "../outside"], fixtureRoot)).resolves.toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      "[signalint] CLI failed: Requested path resolves outside the project root.\n",
    );
  });
});

describe("signalint check --format github", () => {
  it("emits a workflow-command annotation per issue instead of JSON", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const exitCode = await runCli(["check", ".", "--format", "github"], checkFixtureRoot);

    expect(exitCode).toBe(1);
    expect(stdout).toHaveBeenCalledWith(
      "::warning file=src/broken.ts,line=1,col=7::no-unused-vars: Variable 'unusedValue' is"
        + " declared but never used. Unused variables should start with a '_'.\n",
    );
    expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining("schemaVersion"));
  });

  it("rejects an unknown --format value", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const exitCode = await runCli(["check", ".", "--format", "xml"], checkFixtureRoot);

    expect(exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage: signalint check"));
  });
});

describe("signalint check --fail-on-priority", () => {
  it("exits 0 when no cluster is at least as urgent as the threshold", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const exitCode = await runCli(
      ["check", ".", "--fail-on-priority", "1"],
      checkFixtureRoot,
    );

    expect(exitCode).toBe(0);
  });

  it("exits 1 when a cluster's priority is at or below the threshold", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const exitCode = await runCli(
      ["check", ".", "--fail-on-priority", "2"],
      checkFixtureRoot,
    );

    expect(exitCode).toBe(1);
  });

  it("rejects a non-positive-integer threshold", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const exitCode = await runCli(
      ["check", ".", "--fail-on-priority", "0"],
      checkFixtureRoot,
    );

    expect(exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Usage: signalint check"));
  });
});
