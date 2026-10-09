import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionMemory } from "../src/memory/sessionMemory.js";
import { SnapshotStore } from "../src/diagnostics/snapshots.js";
import { dispatchToolCall } from "../src/server/createServer.js";
import type { ToolHandlerContext } from "../src/server/context.js";
import { TransactionManager } from "../src/transactions/manager.js";

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

describe("Transactional previews, safe apply, and rollback", () => {
  let tempDir: string;
  let canonicalRoot: string;
  let stateDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "signalint-tx-test-"));
    canonicalRoot = canonicalizePath(tempDir);
    stateDir = mkdtempSync(join(tmpdir(), "signalint-tx-state-"));
    process.env.SIGNALINT_STATE_DIR = stateDir;

    // Create minimal package.json and config so project markers exist
    writeFileSync(resolve(canonicalRoot, "package.json"), JSON.stringify({ name: "tx-test" }));
    writeFileSync(
      resolve(canonicalRoot, "signalint.config.json"),
      JSON.stringify({ version: "1.0", engines: {} }),
    );
    mkdirSync(resolve(canonicalRoot, "src"), { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  it("prepares a transaction preview in-memory without modifying disk files", () => {
    const manager = new TransactionManager();
    const file1 = "src/a.ts";
    const file2 = "src/b.ts";

    const preview = manager.prepareTransaction(
      [
        { file: file1, originalContent: "", patchedContent: "export const a = 1;\n" },
        { file: file2, originalContent: "", patchedContent: "export const b = 2;\n" },
      ],
      { projectRoot: canonicalRoot },
    );

    expect(preview.transactionId).toMatch(/^tx_[0-9a-f]{32}$/);
    expect(preview.status).toBe("prepared");
    expect(preview.patches.length).toBe(2);

    // Assert files were NOT created on disk
    expect(() => readFileSync(resolve(canonicalRoot, file1), "utf-8")).toThrow();
    expect(() => readFileSync(resolve(canonicalRoot, file2), "utf-8")).toThrow();

    // Verify preview retrieval
    const retrieved = manager.getPreview(preview.transactionId);
    expect(retrieved).toBeDefined();
    expect(retrieved?.transactionId).toBe(preview.transactionId);
  });

  it("discards a prepared transaction from in-memory storage", () => {
    const manager = new TransactionManager();
    const preview = manager.prepareTransaction(
      [{ file: "src/discard.ts", originalContent: "", patchedContent: "const x = 1;" }],
      { projectRoot: canonicalRoot },
    );

    const discarded = manager.discardTransaction(preview.transactionId);
    expect(discarded).toBe(true);

    const afterDiscard = manager.getPreview(preview.transactionId);
    expect(afterDiscard).toBeUndefined();

    // Discarding a second time returns false
    expect(manager.discardTransaction(preview.transactionId)).toBe(false);
  });

  it("applies a valid transaction atomically and triggers post-check verification", async () => {
    const file1Rel = "src/valid1.ts";
    const file2Rel = "src/valid2.ts";
    const file1Abs = resolve(canonicalRoot, file1Rel);
    const file2Abs = resolve(canonicalRoot, file2Rel);

    writeFileSync(file1Abs, "const a = 1;\n", "utf-8");
    writeFileSync(file2Abs, "const b = 2;\n", "utf-8");

    const manager = new TransactionManager();
    const preview = manager.prepareTransaction(
      [
        { file: file1Rel, originalContent: "const a = 1;\n", patchedContent: "const a = 100;\n" },
        { file: file2Rel, originalContent: "const b = 2;\n", patchedContent: "const b = 200;\n" },
      ],
      { projectRoot: canonicalRoot },
    );

    let postCheckCalled = false;
    const result = await manager.applyTransaction(preview.transactionId, {
      projectRoot: canonicalRoot,
      confirm: true,
      onPostCheck: async (filesModified) => {
        postCheckCalled = true;
        expect(filesModified).toContain(file1Rel);
        expect(filesModified).toContain(file2Rel);
        return { postCheckId: "check_post_1", delta: { netErrorDelta: 0 } };
      },
    });

    expect(result.status).toBe("success");
    expect(result.filesModified).toHaveLength(2);
    expect(result.postCheckId).toBe("check_post_1");
    expect(postCheckCalled).toBe(true);

    // Verify files on disk were modified correctly
    expect(readFileSync(file1Abs, "utf-8")).toBe("const a = 100;\n");
    expect(readFileSync(file2Abs, "utf-8")).toBe("const b = 200;\n");
  });

  it("rolls back all written files cleanly when a write failure occurs during apply", async () => {
    const file1Rel = "src/rollback1.ts";
    const file2Rel = "src/rollback2.ts";
    const file1Abs = resolve(canonicalRoot, file1Rel);
    const file2Abs = resolve(canonicalRoot, file2Rel);

    writeFileSync(file1Abs, "original file 1", "utf-8");
    writeFileSync(file2Abs, "original file 2", "utf-8");

    const manager = new TransactionManager();
    const preview = manager.prepareTransaction(
      [
        { file: file1Rel, originalContent: "original file 1", patchedContent: "modified 1" },
        { file: file2Rel, originalContent: "original file 2", patchedContent: "modified 2" },
      ],
      { projectRoot: canonicalRoot },
    );

    let writtenFirst = false;
    const result = await manager.applyTransaction(preview.transactionId, {
      projectRoot: canonicalRoot,
      confirm: true,
      writeFile: (path, content) => {
        if (path.includes("rollback2.ts")) {
          throw new Error("Simulated I/O disk failure on second file");
        }
        writtenFirst = true;
        writeFileSync(path, content, "utf-8");
      },
    });

    expect(writtenFirst).toBe(true);
    expect(result.status).toBe("rolled_back");
    expect(result.filesModified).toHaveLength(0);
    expect(result.error).toContain("Simulated I/O disk failure");

    // Assert file1 was restored to original content, not left modified
    expect(readFileSync(file1Abs, "utf-8")).toBe("original file 1");
    expect(readFileSync(file2Abs, "utf-8")).toBe("original file 2");
  });

  it("rejects transaction application when file content has drifted on disk", async () => {
    const fileRel = "src/drift.ts";
    const fileAbs = resolve(canonicalRoot, fileRel);
    writeFileSync(fileAbs, "initial content", "utf-8");

    const manager = new TransactionManager();
    const preview = manager.prepareTransaction(
      [{ file: fileRel, originalContent: "initial content", patchedContent: "new content" }],
      { projectRoot: canonicalRoot },
    );

    // External process modifies file before apply
    writeFileSync(fileAbs, "external modification", "utf-8");

    const result = await manager.applyTransaction(preview.transactionId, {
      projectRoot: canonicalRoot,
      confirm: true,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("content has drifted");
    expect(readFileSync(fileAbs, "utf-8")).toBe("external modification");
  });

  it("requires explicit confirmation to apply transaction", async () => {
    const manager = new TransactionManager();
    const preview = manager.prepareTransaction(
      [{ file: "src/confirm.ts", originalContent: "", patchedContent: "code" }],
      { projectRoot: canonicalRoot },
    );

    const result = await manager.applyTransaction(preview.transactionId, {
      projectRoot: canonicalRoot,
      confirm: false,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("Confirmation required");
  });

  it("enforces maximum transaction capacity and FIFO eviction", () => {
    const manager = new TransactionManager({ maxTransactions: 3 });

    const tx1 = manager.prepareTransaction(
      [{ file: "src/1.ts", originalContent: "", patchedContent: "1" }],
      { projectRoot: canonicalRoot },
    );
    const tx2 = manager.prepareTransaction(
      [{ file: "src/2.ts", originalContent: "", patchedContent: "2" }],
      { projectRoot: canonicalRoot },
    );
    const tx3 = manager.prepareTransaction(
      [{ file: "src/3.ts", originalContent: "", patchedContent: "3" }],
      { projectRoot: canonicalRoot },
    );
    const tx4 = manager.prepareTransaction(
      [{ file: "src/4.ts", originalContent: "", patchedContent: "4" }],
      { projectRoot: canonicalRoot },
    );

    // Oldest tx1 should have been evicted
    expect(manager.getPreview(tx1.transactionId)).toBeUndefined();
    expect(manager.getPreview(tx2.transactionId)).toBeDefined();
    expect(manager.getPreview(tx3.transactionId)).toBeDefined();
    expect(manager.getPreview(tx4.transactionId)).toBeDefined();
  });

  it("integrates end-to-end through MCP tool dispatch", async () => {
    const fileRel = "src/mcp-tx.ts";
    const fileAbs = resolve(canonicalRoot, fileRel);
    writeFileSync(fileAbs, "const mcp = 1;\n", "utf-8");

    const context: ToolHandlerContext = {
      cwd: canonicalRoot,
      fileIssueProvider: () =>
        Promise.resolve({
          issues: [],
          cache: { hits: 0, misses: 0 },
          engines: { oxlint: { status: "ok" } },
        }),
      projectIssueProvider: () =>
        Promise.resolve({
          issues: [],
          cache: { hits: 0, misses: 0 },
          engines: { oxlint: { status: "ok" } },
        }),
      sessionMemory: new SessionMemory(),
      payloadMode: "both",
      snapshotStore: new SnapshotStore({ projectRoot: canonicalRoot }),
      transactionManager: new TransactionManager(),
    };

    // 1. preview_diagnostic_fix
    const previewResult = await dispatchToolCall(
      "preview_diagnostic_fix",
      {
        patches: [
          {
            file: fileRel,
            originalContent: "const mcp = 1;\n",
            patchedContent: "const mcp = 2;\n",
            description: "Update mcp variable",
          },
        ],
      },
      new AbortController().signal,
      context,
    );

    expect(previewResult.isError).toBeUndefined();
    const previewText = JSON.parse(
      (previewResult.content[0] as { text: string }).text,
    );
    expect(previewText.status).toBe("prepared");
    expect(previewText.transactionId).toBeDefined();

    // 2. apply_diagnostic_fix
    const applyResult = await dispatchToolCall(
      "apply_diagnostic_fix",
      {
        transactionId: previewText.transactionId,
        confirm: true,
      },
      new AbortController().signal,
      context,
    );

    expect(applyResult.isError).toBeUndefined();
    const applyText = JSON.parse(
      (applyResult.content[0] as { text: string }).text,
    );
    expect(applyText.status).toBe("success");
    expect(applyText.filesModified).toContain(fileRel);
    expect(readFileSync(fileAbs, "utf-8")).toBe("const mcp = 2;\n");

    // 3. discard_diagnostic_fix after already applied
    const discardResult = await dispatchToolCall(
      "discard_diagnostic_fix",
      {
        transactionId: previewText.transactionId,
      },
      new AbortController().signal,
      context,
    );
    const discardText = JSON.parse(
      (discardResult.content[0] as { text: string }).text,
    );
    expect(discardText.discarded).toBe(false);
  });
});
