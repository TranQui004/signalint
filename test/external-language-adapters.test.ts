import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  normalizeCargoClippyDiagnostics,
  normalizeGolangCiLintDiagnostics,
  normalizeMypyDiagnostics,
  normalizeRuffDiagnostics,
} from "../src/diagnostics/adapters/index.js";
import { isNormalizedIssue } from "../src/schema.js";

function canonicalizePath(p: string): string {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    try {
      return realpathSync(resolve(p));
    } catch {
      return resolve(p);
    }
  }
}

describe("External language diagnostic adapters (Python, Rust, Go)", () => {
  let tempDir: string;
  let canonicalRoot: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signalint-adapters-test-"));
    canonicalRoot = canonicalizePath(tempDir);

    // Create stub source files so validateHookPath recognizes real or canonical paths
    writeFileSync(resolve(canonicalRoot, "main.py"), "# python\n");
    writeFileSync(resolve(canonicalRoot, "utils.py"), "# utils\n");
    writeFileSync(resolve(canonicalRoot, "lib.rs"), "// rust\n");
    writeFileSync(resolve(canonicalRoot, "main.go"), "// go\n");
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }
  });

  it("normalizes Python Ruff JSON diagnostics with correct coordinates and provenance", () => {
    const ruffJson = [
      {
        cell: null,
        code: "F401",
        end_location: { column: 16, row: 1 },
        filename: "main.py",
        fix: null,
        location: { column: 1, row: 1 },
        message: "`os` imported but unused",
        noqa_row: 1,
        url: "https://docs.astral.sh/ruff/rules/unused-import",
      },
      {
        cell: null,
        code: "I001",
        end_location: { column: 1, row: 2 },
        filename: "main.py",
        fix: { applicability: "automatic", message: "Organize imports" },
        location: { column: 1, row: 1 },
        message: "Import block is un-sorted or un-formatted",
      },
    ];

    const issues = normalizeRuffDiagnostics(ruffJson, { projectRoot: canonicalRoot });

    expect(issues.length).toBe(2);

    const first = issues[0]!;
    expect(first.file).toBe("main.py");
    expect(first.line).toBe(1);
    expect(first.col).toBe(1);
    expect(first.rule).toBe("ruff(F401)");
    expect(first.engine).toBe("external-lsp");
    expect(first.serverName).toBe("ruff");
    expect(first.sourceKind).toBe("linter");
    expect(first.fixable).toBe(false);
    expect(first.provenance).toMatchObject({
      kind: "linter",
      engine: "external-lsp",
      serverName: "ruff",
    });
    expect(isNormalizedIssue(first)).toBe(true);

    const second = issues[1]!;
    expect(second.rule).toBe("ruff(I001)");
    expect(second.fixable).toBe(true);
    expect(isNormalizedIssue(second)).toBe(true);
  });

  it("normalizes Python Mypy JSON diagnostics with correct coordinates and provenance", () => {
    const mypyJson = JSON.stringify([
      {
        file: "utils.py",
        line: 10,
        column: 5,
        message: "Incompatible return value type (got 'int', expected 'str')",
        severity: "error",
        code: "return-value",
      },
    ]);

    const issues = normalizeMypyDiagnostics(mypyJson, { projectRoot: canonicalRoot });

    expect(issues.length).toBe(1);
    const issue = issues[0]!;
    expect(issue.file).toBe("utils.py");
    expect(issue.line).toBe(10);
    expect(issue.col).toBe(5);
    expect(issue.rule).toBe("mypy(return-value)");
    expect(issue.severity).toBe("error");
    expect(issue.serverName).toBe("mypy");
    expect(issue.sourceKind).toBe("compiler");
    expect(issue.provenance).toMatchObject({
      kind: "compiler",
      engine: "external-lsp",
      serverName: "mypy",
    });
    expect(isNormalizedIssue(issue)).toBe(true);
  });

  it("normalizes Rust Cargo and Clippy JSON streams ignoring artifacts", () => {
    const cargoNdjson = [
      JSON.stringify({ reason: "compiler-artifact", package_id: "signalint 0.1.0" }),
      JSON.stringify({
        reason: "compiler-message",
        message: {
          code: { code: "clippy::needless_return" },
          level: "warning",
          message: "unneeded `return` statement",
          spans: [
            {
              file_name: "lib.rs",
              line_start: 12,
              line_end: 12,
              column_start: 5,
              column_end: 14,
              is_primary: true,
            },
          ],
        },
      }),
      JSON.stringify({
        reason: "compiler-message",
        message: {
          code: { code: "E0308" },
          level: "error",
          message: "mismatched types: expected `u32`, found `&str`",
          spans: [
            {
              file_name: "lib.rs",
              line_start: 25,
              column_start: 9,
              is_primary: true,
            },
          ],
        },
      }),
    ].join("\n");

    const issues = normalizeCargoClippyDiagnostics(cargoNdjson, { projectRoot: canonicalRoot });

    expect(issues.length).toBe(2);

    const clippyIssue = issues[0]!;
    expect(clippyIssue.file).toBe("lib.rs");
    expect(clippyIssue.line).toBe(12);
    expect(clippyIssue.col).toBe(5);
    expect(clippyIssue.rule).toBe("cargo-clippy(clippy::needless_return)");
    expect(clippyIssue.severity).toBe("warning");
    expect(clippyIssue.sourceKind).toBe("linter");
    expect(clippyIssue.provenance).toMatchObject({
      kind: "linter",
      serverName: "cargo-clippy",
    });
    expect(isNormalizedIssue(clippyIssue)).toBe(true);

    const rustcIssue = issues[1]!;
    expect(rustcIssue.file).toBe("lib.rs");
    expect(rustcIssue.line).toBe(25);
    expect(rustcIssue.col).toBe(9);
    expect(rustcIssue.rule).toBe("cargo-clippy(E0308)");
    expect(rustcIssue.severity).toBe("error");
    expect(rustcIssue.sourceKind).toBe("compiler");
    expect(isNormalizedIssue(rustcIssue)).toBe(true);
  });

  it("normalizes Go golangci-lint JSON report with linter rule and coordinates", () => {
    const golangReport = {
      Issues: [
        {
          FromLinter: "govet",
          Text: "printf: Printf format %s reads arg #1, but call has 0 args",
          Severity: "error",
          Pos: {
            Filename: "main.go",
            Line: 18,
            Column: 2,
          },
        },
      ],
      Report: {},
    };

    const issues = normalizeGolangCiLintDiagnostics(golangReport, { projectRoot: canonicalRoot });

    expect(issues.length).toBe(1);
    const issue = issues[0]!;
    expect(issue.file).toBe("main.go");
    expect(issue.line).toBe(18);
    expect(issue.col).toBe(2);
    expect(issue.rule).toBe("golangci-lint(govet)");
    expect(issue.severity).toBe("error");
    expect(issue.serverName).toBe("golangci-lint");
    expect(issue.sourceKind).toBe("linter");
    expect(issue.provenance).toMatchObject({
      kind: "linter",
      serverName: "golangci-lint",
    });
    expect(isNormalizedIssue(issue)).toBe(true);
  });

  it("rejects escaping directory traversal paths in external diagnostics", () => {
    const escapingPayload = [
      {
        filename: "../../outside/secret.py",
        message: "Syntax error outside root",
        location: { row: 1, column: 1 },
      },
    ];

    expect(() =>
      normalizeRuffDiagnostics(escapingPayload, { projectRoot: canonicalRoot }),
    ).toThrow();
  });
});
