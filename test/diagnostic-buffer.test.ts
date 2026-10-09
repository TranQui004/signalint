import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DiagnosticBuffer } from "../src/diagnostics/buffer.js";
import { canonicalizePath } from "../src/projectPaths.js";
import type { NormalizedIssue } from "../src/schema.js";

function makeIssue(
  file: string,
  rule: string,
  line: number,
  col: number,
  severity: "error" | "warning" = "error",
): NormalizedIssue {
  return {
    issueId: `id-${file}-${rule}-${line}-${col}`,
    file,
    line,
    col,
    engine: "external-lsp",
    rule,
    severity,
    message: `Issue at ${file}:${line}:${col}`,
    fixable: false,
    sourceKind: "lsp",
  };
}

describe("DiagnosticBuffer event burst deduplication and bounded capacity", () => {
  let tempDir: string;
  let canonicalRoot: string;
  const originalStateDir = process.env.SIGNALINT_STATE_DIR;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signalint-buffer-test-"));
    canonicalRoot = canonicalizePath(tempDir);
    process.env.SIGNALINT_STATE_DIR = canonicalRoot;
  });

  afterAll(() => {
    if (originalStateDir !== undefined) {
      process.env.SIGNALINT_STATE_DIR = originalStateDir;
    } else {
      delete process.env.SIGNALINT_STATE_DIR;
    }
    rmSync(canonicalRoot, { recursive: true, force: true });
  });

  it("deduplicates multiple rapid diagnostic events with the same location and rule to 1 issue", () => {
    const buffer = new DiagnosticBuffer({ debounceMs: 20 });

    const issue1 = makeIssue("src/index.ts", "typescript(2304)", 10, 5, "error");
    const issue2 = makeIssue("src/index.ts", "typescript(2304)", 10, 5, "error");

    buffer.ingest([issue1]);
    buffer.ingest([issue2]);
    buffer.ingest([issue1]);

    expect(buffer.size).toBe(1);
    const issues = buffer.getIssues();
    expect(issues.length).toBe(1);
    expect(issues[0]?.rule).toBe("typescript(2304)");
  });

  it("enforces bounded capacity when 1,000+ diagnostics are ingested", () => {
    const maxCapacity = 500;
    const buffer = new DiagnosticBuffer({ maxCapacity, debounceMs: 10 });

    const batch: NormalizedIssue[] = [];
    for (let i = 0; i < 1200; i++) {
      batch.push(makeIssue(`src/file-${i}.ts`, `rule-${i % 10}`, i + 1, 1));
    }

    buffer.ingest(batch);

    expect(buffer.size).toBe(maxCapacity);
    const issues = buffer.getIssues();
    expect(issues.length).toBe(maxCapacity);

    // Oldest issues (0 to 699) should have been evicted; newest (700 to 1199) retained
    const files = new Set(issues.map((i) => i.file));
    expect(files.has("src/file-0.ts")).toBe(false);
    expect(files.has("src/file-1199.ts")).toBe(true);
  });

  it("filters diagnostics by file and severity", () => {
    const buffer = new DiagnosticBuffer();

    buffer.ingest([
      makeIssue("src/a.ts", "rule-a", 1, 1, "error"),
      makeIssue("src/a.ts", "rule-b", 2, 1, "warning"),
      makeIssue("src/b.ts", "rule-c", 3, 1, "error"),
    ]);

    expect(buffer.getIssues({ files: ["src/a.ts"] }).length).toBe(2);
    expect(buffer.getIssues({ files: ["src/b.ts"] }).length).toBe(1);
    expect(buffer.getIssues({ severity: "error" }).length).toBe(2);
    expect(buffer.getIssues({ severity: "warning" }).length).toBe(1);
    expect(buffer.getIssues({ files: ["src/a.ts"], severity: "error" }).length).toBe(1);
  });

  it("supports explicit flush, settle, and removeFile", async () => {
    const buffer = new DiagnosticBuffer({ debounceMs: 30 });

    buffer.ingest([
      makeIssue("src/a.ts", "rule-a", 1, 1, "error"),
      makeIssue("src/b.ts", "rule-b", 1, 1, "warning"),
    ]);

    const flushed = buffer.flush();
    expect(flushed.length).toBe(2);

    const settled = await buffer.settle();
    expect(settled.length).toBe(2);

    buffer.removeFile("src/a.ts");
    expect(buffer.size).toBe(1);
    expect(buffer.getIssues()[0]?.file).toBe("src/b.ts");

    buffer.clear();
    expect(buffer.size).toBe(0);
  });
});
