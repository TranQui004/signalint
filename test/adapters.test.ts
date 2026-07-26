import { describe, expect, it } from "vitest";

import { parseBiomeOutput } from "../src/adapters/biome.js";
import { parseOxlintOutput } from "../src/adapters/oxlint.js";
import { parseTscOutput } from "../src/adapters/tsc.js";
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
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
