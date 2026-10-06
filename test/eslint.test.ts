import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createEslintCliArgs,
  parseEslintOutput,
  runEslint,
} from "../src/engines/eslint.js";
import { EngineDisabledError } from "../src/engineFanout.js";

describe("ESLint adapter", () => {
  it("builds CLI arguments with JSON format and path terminator", () => {
    const args = createEslintCliArgs("bin/eslint.js", ["src/index.ts", "src/util.ts"]);
    expect(args).toEqual([
      "bin/eslint.js",
      "-f",
      "json",
      "--no-error-on-unmatched-pattern",
      "--",
      "src/index.ts",
      "src/util.ts",
    ]);
  });

  it("parses empty or whitespace output to an empty array", () => {
    expect(parseEslintOutput("")).toEqual([]);
    expect(parseEslintOutput("   \n  ")).toEqual([]);
  });

  it("throws on invalid JSON or non-array output", () => {
    expect(() => parseEslintOutput("invalid json")).toThrow();
    expect(() => parseEslintOutput('{"error":"not an array"}')).toThrow(
      "ESLint output did not contain a results array.",
    );
  });

  it("normalizes ESLint diagnostics, severities, and fixable flag", () => {
    const cwd = resolve("test/fixtures/sample-project");
    const fakeJson = JSON.stringify([
      {
        filePath: resolve(cwd, "src/broken.ts"),
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "Variable 'x' is defined but never used.",
            line: 5,
            column: 7,
            fix: {
              range: [10, 15],
              text: "",
            },
          },
          {
            ruleId: "prefer-const",
            severity: 1,
            message: "Variable 'y' should be const.",
            line: 10,
            column: 1,
          },
          {
            ruleId: null,
            severity: 2,
            message: "Parsing error: Unexpected token",
            line: 0,
            column: 0,
          },
        ],
      },
    ]);

    const issues = parseEslintOutput(fakeJson, cwd);
    expect(issues).toHaveLength(3);

    expect(issues[0]).toMatchObject({
      file: "src/broken.ts",
      line: 5,
      col: 7,
      rule: "no-unused-vars",
      severity: "error",
      engine: "eslint",
      fixable: true,
      message: "Variable 'x' is defined but never used.",
    });

    expect(issues[1]).toMatchObject({
      file: "src/broken.ts",
      line: 10,
      col: 1,
      rule: "prefer-const",
      severity: "warning",
      engine: "eslint",
      fixable: false,
      message: "Variable 'y' should be const.",
    });

    expect(issues[2]).toMatchObject({
      file: "src/broken.ts",
      line: 1,
      col: 1,
      rule: "eslint/syntax",
      severity: "error",
      engine: "eslint",
      fixable: false,
    });
  });

  it("throws EngineDisabledError when ESLint is not installed in the project", async () => {
    const emptyDir = resolve("test/fixtures/fresh-install-project");
    await expect(runEslint(["."], { cwd: emptyDir })).rejects.toThrow(EngineDisabledError);
    await expect(runEslint(["."], { cwd: emptyDir })).rejects.toThrow(
      "ESLint is not installed in this project.",
    );
  });
});
