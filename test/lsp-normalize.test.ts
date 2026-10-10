import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  decodeFileUri,
  formatLspRule,
  normalizeLspDiagnostic,
} from "../src/diagnostics/normalize.js";
import { canonicalizePath } from "../src/projectPaths.js";
import { HookPathError } from "../src/hooks/paths.js";
import { isNormalizedIssue } from "../src/schema.js";

describe("LSP diagnostic normalization and provenance", () => {
  let tempDir: string;
  let canonicalRoot: string;
  const originalStateDir = process.env.SIGNALINT_STATE_DIR;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signalint-lsp-norm-"));
    canonicalRoot = canonicalizePath(resolve(tempDir));
    process.env.SIGNALINT_STATE_DIR = canonicalRoot;
    writeFileSync(resolve(canonicalRoot, "sample.ts"), "const x = 1;\n");
  });

  afterAll(() => {
    if (originalStateDir !== undefined) {
      process.env.SIGNALINT_STATE_DIR = originalStateDir;
    } else {
      delete process.env.SIGNALINT_STATE_DIR;
    }
    rmSync(canonicalRoot, { recursive: true, force: true });
  });

  it("converts 0-based LSP range coordinates to 1-based line and col", () => {
    const raw = {
      file: "sample.ts",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      message: "Unused variable 'x'",
      severity: 1,
    };
    const issue = normalizeLspDiagnostic(raw, { projectRoot: canonicalRoot });
    expect(issue).not.toBeNull();
    expect(issue?.line).toBe(1);
    expect(issue?.col).toBe(1);

    const rawOffset = {
      file: "sample.ts",
      range: {
        start: { line: 42, character: 15 },
        end: { line: 42, character: 20 },
      },
      message: "Type mismatch",
      severity: 2,
    };
    const offsetIssue = normalizeLspDiagnostic(rawOffset, { projectRoot: canonicalRoot });
    expect(offsetIssue?.line).toBe(43);
    expect(offsetIssue?.col).toBe(16);
  });

  it("maps LSP severity codes correctly (1 -> error, 2 -> warning)", () => {
    const errorDiag = {
      file: "sample.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "Fatal syntax error",
      severity: 1,
    };
    const errorIssue = normalizeLspDiagnostic(errorDiag, { projectRoot: canonicalRoot });
    expect(errorIssue?.severity).toBe("error");

    const warnDiag = {
      file: "sample.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "Deprecated API",
      severity: 2,
    };
    const warnIssue = normalizeLspDiagnostic(warnDiag, { projectRoot: canonicalRoot });
    expect(warnIssue?.severity).toBe("warning");

    const infoDiag = {
      file: "sample.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      message: "Suggestion",
      severity: 3,
    };
    const infoIssue = normalizeLspDiagnostic(infoDiag, { projectRoot: canonicalRoot });
    expect(infoIssue?.severity).toBe("warning");

    const ignored = normalizeLspDiagnostic(infoDiag, {
      projectRoot: canonicalRoot,
      ignoreInfoAndHints: true,
    });
    expect(ignored).toBeNull();
  });

  it("decodes file:// URIs correctly across POSIX and Windows", () => {
    expect(decodeFileUri("file:///path/to/project/file.ts")).toBe("/path/to/project/file.ts");
    expect(decodeFileUri("file:///C:/Users/test/project/file.ts")).toMatch(/^[a-zA-Z]:[\\/]/);
    expect(decodeFileUri("sample.ts")).toBe("sample.ts");

    const fileUri = `file://${canonicalRoot.replace(/\\/g, "/")}/sample.ts`;
    const issue = normalizeLspDiagnostic(
      {
        uri: fileUri,
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 4 } },
        message: "URI diagnostic",
      },
      { projectRoot: canonicalRoot },
    );
    expect(issue?.file).toBe("sample.ts");
  });

  it("rejects escaping paths or directory traversal in ingested diagnostics", () => {
    expect(() =>
      normalizeLspDiagnostic(
        {
          file: "../outside.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: "Escaping diagnostic",
        },
        { projectRoot: canonicalRoot },
      ),
    ).toThrow(HookPathError);

    expect(() =>
      normalizeLspDiagnostic(
        {
          file: "src/../../outside.ts",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: "Traversal diagnostic",
        },
        { projectRoot: canonicalRoot },
      ),
    ).toThrow(HookPathError);
  });

  it("formats rules and creates stable issueId", () => {
    expect(formatLspRule("typescript", 2304)).toBe("typescript(2304)");
    expect(formatLspRule("eslint", "@typescript-eslint/no-explicit-any")).toBe(
      "eslint(@typescript-eslint/no-explicit-any)",
    );
    expect(formatLspRule(undefined, "TS1005")).toBe("TS1005");
    expect(formatLspRule("vtsls", undefined)).toBe("vtsls");
    expect(formatLspRule(undefined, undefined)).toBe("lsp");

    const issue1 = normalizeLspDiagnostic(
      {
        file: "sample.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        code: 2304,
        source: "typescript",
        message: "Cannot find name 'foo'",
      },
      { projectRoot: canonicalRoot },
    );
    const issue2 = normalizeLspDiagnostic(
      {
        file: "sample.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        code: 2304,
        source: "typescript",
        message: "Cannot find name 'bar'",
      },
      { projectRoot: canonicalRoot },
    );
    expect(issue1?.issueId).toBe(issue2?.issueId);
  });

  it("retains engine: 'external-lsp' and serverName metadata without polluting core compiler engines", () => {
    const issue = normalizeLspDiagnostic(
      {
        file: "sample.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        message: "Type error",
      },
      {
        projectRoot: canonicalRoot,
        serverName: "vtsls",
      },
    );
    expect(issue).not.toBeNull();
    expect(issue?.engine).toBe("external-lsp");
    expect(issue?.serverName).toBe("vtsls");
    expect(issue?.sourceKind).toBe("lsp");
    expect(isNormalizedIssue(issue)).toBe(true);
  });
});
