import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createBiomeCliArgs, parseBiomeOutput } from "../src/adapters/biome.js";
import { createOxlintCliArgs, parseOxlintOutput } from "../src/adapters/oxlint.js";
import {
  createTscArgs,
  parseTscOutput,
  runTsc,
} from "../src/adapters/tsc.js";
import { isNormalizedIssue } from "../src/schema.js";

const OXLINT_OUTPUT = JSON.stringify({
  diagnostics: [
    {
      message:
        "Variable 'unusedValue' is declared but never used. Unused variables should start with a '_'.",
      code: "eslint(no-unused-vars)",
      severity: "warning",
      help: "Consider removing this declaration.",
      filename: "src/broken.ts",
      labels: [
        {
          label: "'unusedValue' is declared here",
          span: { offset: 6, length: 11, line: 1, column: 7 },
        },
      ],
    },
  ],
});

const TSC_OUTPUT = [
  "src/broken.ts(3,14): error TS2322: Type 'string' is not assignable to type",
  "  'number'.",
].join("\n");

const DECLARATION_TSC_OUTPUT =
  "node_modules/broken-package/index.d.ts(6,1): error TS1036: " +
  "Statements are not allowed in ambient contexts.";

const PREFIXLESS_DECLARATION_TSC_OUTPUT =
  "node_modules/broken-package/index.d.ts(8,1): error 2309: " +
  "An export assignment cannot be used in a module with other exported elements.";

const DECLARATION_OXLINT_OUTPUT = JSON.stringify({
  diagnostics: [
    {
      message: "Statements are not allowed in ambient contexts.",
      code: "TS(1036)",
      severity: "error",
      filename: "node_modules/broken-package/index.d.ts",
      labels: [
        {
          span: { offset: 90, length: 17, line: 6, column: 1 },
        },
      ],
    },
  ],
});

const declarationFixture = resolve("test/fixtures/node-modules-project");
const solutionStyleFixture = resolve("test/fixtures/solution-style-project");

// Captured from @biomejs/biome 2.5.5: `biome check --reporter=json src/broken.ts`.
const BIOME_OUTPUT = JSON.stringify({
  summary: {
    changed: 0,
    unchanged: 1,
    matches: 0,
    duration: 5105100,
    errors: 0,
    warnings: 1,
    infos: 0,
    skipped: 0,
    suggestedFixesSkipped: 0,
    diagnosticsNotPrinted: 0,
    scannerDuration: 2436000,
  },
  diagnostics: [
    {
      severity: "warning",
      message: "This variable unusedValue is unused.",
      category: "lint/correctness/noUnusedVariables",
      location: {
        path: "src/broken.ts",
        start: { line: 1, column: 7 },
        end: { line: 1, column: 18 },
      },
      advices: [],
    },
  ],
  command: "check",
});

describe("Oxlint adapter", () => {
  it("parses known JSON output into the exact Normalized Issue schema", () => {
    const issues = parseOxlintOutput(OXLINT_OUTPUT);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: "src/broken.ts",
      line: 1,
      col: 7,
      engine: "oxlint",
      rule: "no-unused-vars",
      severity: "warning",
      message:
        "Variable 'unusedValue' is declared but never used. Unused variables should start with a '_'.",
      fixable: false,
    });
    expect(issues[0]).not.toHaveProperty("clusterId");
    expect(issues.every(isNormalizedIssue)).toBe(true);
  });

  it("requires concrete replacement data before marking an issue fixable", () => {
    const withFix = JSON.parse(OXLINT_OUTPUT) as unknown;
    if (!isRecord(withFix) || !Array.isArray(withFix.diagnostics) || !isRecord(withFix.diagnostics[0])) {
      throw new Error("Test fixture did not have the expected shape.");
    }
    withFix.diagnostics[0].fix = {
      text: "",
      span: { offset: 0, length: 18 },
    };

    expect(parseOxlintOutput(JSON.stringify(withFix))[0]?.fixable).toBe(true);
  });

  it("preserves the TS prefix on declaration-file diagnostics", () => {
    const issues = parseOxlintOutput(DECLARATION_OXLINT_OUTPUT);

    expect(issues[0]).toMatchObject({
      file: "node_modules/broken-package/index.d.ts",
      engine: "oxlint",
      rule: "TS1036",
    });
  });

  it("places an end-of-options separator before every supplied path", () => {
    expect(createOxlintCliArgs("oxlint-cli", ["src/a.ts", "-hostile.ts"])).toEqual([
      "oxlint-cli",
      "--format",
      "json",
      "--",
      "src/a.ts",
      "-hostile.ts",
    ]);
  });
});

describe("tsc adapter", () => {
  it("parses multiline non-pretty output into the exact Normalized Issue schema", () => {
    const issues = parseTscOutput(TSC_OUTPUT);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: "src/broken.ts",
      line: 3,
      col: 14,
      engine: "tsc",
      rule: "TS2322",
      severity: "error",
      message: "Type 'string' is not assignable to type 'number'.",
      fixable: false,
    });
    expect(issues[0]).not.toHaveProperty("clusterId");
    expect(issues.every(isNormalizedIssue)).toBe(true);
  });

  it("preserves or restores the TS prefix for declaration-file diagnostics", () => {
    const prefixed = parseTscOutput(DECLARATION_TSC_OUTPUT);
    const prefixless = parseTscOutput(PREFIXLESS_DECLARATION_TSC_OUTPUT);

    expect(prefixed[0]).toMatchObject({
      file: "node_modules/broken-package/index.d.ts",
      rule: "TS1036",
    });
    expect(prefixless[0]).toMatchObject({
      file: "node_modules/broken-package/index.d.ts",
      rule: "TS2309",
    });
    expect([...prefixed, ...prefixless].every(isNormalizedIssue)).toBe(true);
  });

  it("defaults skipLibCheck only when the effective project config leaves it unset", async () => {
    const defaultArgs = await createTscArgs(["."], declarationFixture);
    const explicitFalseArgs = await createTscArgs(
      ["tsconfig.explicit-false.json"],
      declarationFixture,
    );
    const explicitTrueArgs = await createTscArgs(
      ["tsconfig.explicit-true.json"],
      declarationFixture,
    );

    expect(defaultArgs).toContain("--skipLibCheck");
    expect(defaultArgs).toContain("--project");
    expect(defaultArgs).not.toContain("--build");
    expect(explicitFalseArgs).not.toContain("--skipLibCheck");
    expect(explicitTrueArgs).not.toContain("--skipLibCheck");
  });

  it("builds a solution-style root and reports diagnostics from referenced projects", async () => {
    const args = await createTscArgs(["."], solutionStyleFixture);
    const issues = await runTsc(["."], { cwd: solutionStyleFixture });

    expect(args[0]).toBe("--build");
    expect(args).not.toContain("--project");
    expect(args).not.toContain("--tsBuildInfoFile");
    expect(args).not.toContain("--skipLibCheck");
    expect(issues).toEqual([
      expect.objectContaining({
        file: "frontend/src/broken.ts",
        line: 1,
        col: 14,
        engine: "tsc",
        rule: "TS2322",
        severity: "error",
        message: "Type 'string' is not assignable to type 'number'.",
        fixable: false,
      }),
    ]);
    expect(issues.every(isNormalizedIssue)).toBe(true);
  });

  it("suppresses library declaration diagnostics in a real default-config run", async () => {
    const issues = await runTsc(["."], { cwd: declarationFixture });

    expect(issues).toEqual([]);
  });

  it("rejects hostile project paths before constructing tsc argv", async () => {
    await expect(createTscArgs(["--version"], solutionStyleFixture)).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(createTscArgs(["../tsconfig.json"], solutionStyleFixture)).rejects.toMatchObject({
      code: "path_outside_project",
    });
  });
});

describe("Biome adapter", () => {
  it("parses known JSON reporter output into the exact Normalized Issue schema", () => {
    const issues = parseBiomeOutput(BIOME_OUTPUT);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: "src/broken.ts",
      line: 1,
      col: 7,
      engine: "biome",
      rule: "lint/correctness/noUnusedVariables",
      severity: "warning",
      message: "This variable unusedValue is unused.",
      fixable: false,
    });
    expect(issues[0]).not.toHaveProperty("clusterId");
    expect(issues.every(isNormalizedIssue)).toBe(true);
  });

  it("places an end-of-options separator before every supplied path", () => {
    expect(createBiomeCliArgs("biome-cli", ["src/a.ts", "-hostile.ts"])).toEqual([
      "biome-cli",
      "check",
      "--reporter=json",
      "--",
      "src/a.ts",
      "-hostile.ts",
    ]);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
