import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  filterIgnoredPaths,
  isIgnoredPath,
  loadSignalintConfig,
  parseSignalintConfig,
} from "../src/config.js";
import { checkConfiguredFiles, collectProjectIssues } from "../src/index.js";

const fixtureRoot = resolve("test/fixtures/config-project");

describe("Signalint configuration", () => {
  it("loads engine switches and ignore globs from the project root", async () => {
    const config = await loadSignalintConfig(fixtureRoot);

    expect(config).toEqual({
      engines: { oxlint: false, tsc: false, biome: true },
      ignore: ["src/ignored.ts"],
    });
  });

  it("fills omitted fields and rejects unknown engine names", () => {
    expect(parseSignalintConfig('{"engines":{"biome":true}}')).toEqual({
      engines: { oxlint: true, tsc: true, biome: true },
      ignore: ["node_modules/**", "dist/**", ".signalint/**"],
    });
    expect(() => parseSignalintConfig('{"engines":{"eslint":true}}')).toThrow(
      'Unknown "engines" field "eslint".',
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
