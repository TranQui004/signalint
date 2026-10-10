import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  filterIgnoredPaths,
  isIgnoredPath,
  loadSignalintConfig,
  parseSignalintConfig,
  resolveMcpPayloadMode,
} from "../src/config.js";
import { checkConfiguredFiles, collectProjectIssues } from "../src/index.js";

const fixtureRoot = resolve("test/fixtures/config-project");

describe("Signalint configuration", () => {
  let tempStateDir: string;
  let originalStateDir: string | undefined;

  beforeAll(() => {
    originalStateDir = process.env.SIGNALINT_STATE_DIR;
    tempStateDir = mkdtempSync(join(tmpdir(), "signalint-config-test-"));
    process.env.SIGNALINT_STATE_DIR = tempStateDir;
  });

  afterAll(() => {
    if (originalStateDir !== undefined) {
      process.env.SIGNALINT_STATE_DIR = originalStateDir;
    } else {
      delete process.env.SIGNALINT_STATE_DIR;
    }
    rmSync(tempStateDir, { recursive: true, force: true });
  });

  it("loads engine switches and ignore globs from the project root", async () => {
    const config = await loadSignalintConfig(fixtureRoot);

    expect(config).toEqual({
      engines: { oxlint: false, tsc: false, biome: true, eslint: false },
      ignore: ["src/ignored.ts"],
      timeoutsMs: { oxlint: 10_000, tsc: 20_000, biome: 15_000, eslint: 30_000 },
      mcpPayload: "both",
    });
  });

  it("fills omitted fields and rejects unknown engine names", () => {
    expect(parseSignalintConfig('{"engines":{"biome":true}}')).toEqual({
      engines: { oxlint: true, tsc: true, biome: true, eslint: false },
      ignore: ["node_modules/**", "dist/**", ".signalint/**"],
      timeoutsMs: { oxlint: 30_000, tsc: 60_000, biome: 30_000, eslint: 30_000 },
      mcpPayload: "both",
    });
    expect(() => parseSignalintConfig('{"engines":{"unknownEngine":true}}')).toThrow(
      'Unknown "engines" field "unknownEngine".',
    );
  });

  it("parses valid mcpPayload values and rejects invalid ones", () => {
    expect(parseSignalintConfig('{"mcpPayload":"text"}').mcpPayload).toBe("text");
    expect(parseSignalintConfig('{"mcpPayload":"structured"}').mcpPayload).toBe("structured");
    expect(parseSignalintConfig('{"mcpPayload":"both"}').mcpPayload).toBe("both");
    expect(() => parseSignalintConfig('{"mcpPayload":"invalid"}')).toThrow(
      'signalint.config.json field "mcpPayload" must be "text", "structured", or "both".',
    );
  });

  it("resolves MCP payload mode with env > config > default precedence", () => {
    // 1. Default when neither env nor config is set
    expect(resolveMcpPayloadMode()).toBe("both");
    expect(resolveMcpPayloadMode(undefined, undefined)).toBe("both");

    // 2. Config used when env is not set
    expect(resolveMcpPayloadMode("text", undefined)).toBe("text");
    expect(resolveMcpPayloadMode("structured", "")).toBe("structured");

    // 3. Env takes precedence over config
    expect(resolveMcpPayloadMode("both", "text")).toBe("text");
    expect(resolveMcpPayloadMode("text", "structured")).toBe("structured");
    expect(resolveMcpPayloadMode("structured", "both")).toBe("both");

    // 4. Invalid env throws error
    expect(() => resolveMcpPayloadMode("both", "invalid")).toThrow(
      'Invalid SIGNALINT_MCP_PAYLOAD "invalid": expected "text", "structured", or "both".',
    );
  });

  it("loads per-engine millisecond timeouts and rejects invalid values", () => {
    expect(parseSignalintConfig('{"timeoutsMs":{"tsc":2500}}').timeoutsMs).toEqual({
      oxlint: 30_000,
      tsc: 2_500,
      biome: 30_000,
      eslint: 30_000,
    });
    expect(() => parseSignalintConfig('{"timeoutsMs":{"oxlint":0}}')).toThrow(
      'timeout "oxlint" must be a positive integer in milliseconds',
    );
  });

  it("matches recursive and filename globs on normalized paths", () => {
    const globs = ["dist/**", "**/*.generated.ts"];

    expect(isIgnoredPath("dist", globs)).toBe(true);
    expect(isIgnoredPath("dist/src/index.js", globs)).toBe(true);
    expect(isIgnoredPath("src/models/user.generated.ts", globs)).toBe(true);
    expect(filterIgnoredPaths(["src/index.ts", "dist/index.js"], globs)).toEqual([
      "src/index.ts",
    ]);
  });

  it("runs only enabled engines and removes ignored diagnostics", async () => {
    const issues = await collectProjectIssues(["src"], fixtureRoot);

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((issue) => issue.engine === "biome")).toBe(true);
    expect(issues.every((issue) => issue.file === "src/included.ts")).toBe(true);
    await expect(checkConfiguredFiles(["src/ignored.ts"], fixtureRoot)).resolves.toEqual([]);
  });
});
