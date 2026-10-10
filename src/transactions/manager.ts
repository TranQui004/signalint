import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { validateHookPath } from "../hooks/paths.js";
import type {
  ApplyResult,
  ApplyTransactionOptions,
  FilePatch,
  PrepareTransactionOptions,
  TransactionPreview,
} from "./types.js";

const DEFAULT_TRANSACTION_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_STORED_TRANSACTIONS = 20;

interface StoredTransaction {
  preview: TransactionPreview;
}

interface JournalEntry {
  file: string;
  fullPath: string;
  existed: boolean;
  originalContent: string;
  applied: boolean;
}

/** Computes SHA-256 digest of file content string. */
function computeContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Atomically replaces destination path with temp file handling Windows rename edge cases. */
function replaceFileAtomically(tempPath: string, targetPath: string): void {
  try {
    renameSync(tempPath, targetPath);
  } catch (renameError: unknown) {
    if (
      isErrnoException(renameError) &&
      (renameError.code === "EPERM" || renameError.code === "EEXIST" || renameError.code === "EBUSY")
    ) {
      try {
        if (existsSync(targetPath)) {
          unlinkSync(targetPath);
        }
        renameSync(tempPath, targetPath);
        return;
      } catch {
        // Fall back to original error
      }
    }
    throw renameError;
  }
}

/** Writes file content using an adjacent temporary file and atomic rename. */
function atomicWriteFile(
  targetPath: string,
  content: string,
  writeFn: (path: string, content: string) => void,
): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const randomHex = randomBytes(4).toString("hex");
  const tempPath = `${targetPath}.signalint-tmp-${Date.now()}-${randomHex}`;
  try {
    writeFn(tempPath, content);
    replaceFileAtomically(tempPath, targetPath);
  } finally {
    if (existsSync(tempPath)) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Best effort temp cleanup
      }
    }
  }
}

/**
 * Manages in-memory previews and journaled, recoverable multi-file transactions for code modifications.
 */
export class TransactionManager {
  private readonly transactions = new Map<string, StoredTransaction>();
  private readonly maxTransactions: number;
  private readonly defaultTtlMs: number;

  constructor(options?: { maxTransactions?: number; defaultTtlMs?: number }) {
    this.maxTransactions = options?.maxTransactions ?? MAX_STORED_TRANSACTIONS;
    this.defaultTtlMs = options?.defaultTtlMs ?? DEFAULT_TRANSACTION_TTL_MS;
  }

  /** Prepares an in-memory transactional preview without modifying any files on disk. */
  prepareTransaction(
    patches: FilePatch[],
    options: PrepareTransactionOptions,
  ): TransactionPreview {
    this.purgeExpired();

    if (!Array.isArray(patches) || patches.length === 0) {
      throw new Error("Cannot prepare transaction: patches list cannot be empty.");
    }

    const validatedPatches: FilePatch[] = patches.map((patch) => {
      if (!patch.file || typeof patch.file !== "string") {
        throw new Error("Invalid patch: missing required 'file' property.");
      }
      const normalizedPath = validateHookPath(patch.file, options.projectRoot);
      const originalHash = patch.originalHash ?? computeContentHash(patch.originalContent);
      return {
        file: normalizedPath,
        originalContent: patch.originalContent,
        originalHash,
        patchedContent: patch.patchedContent,
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      };
    });

    while (this.transactions.size >= this.maxTransactions) {
      const oldestKey = this.transactions.keys().next().value;
      if (oldestKey !== undefined) {
        this.transactions.delete(oldestKey);
      } else {
        break;
      }
    }

    const transactionId = `tx_${randomBytes(16).toString("hex")}`;
    const now = Date.now();
    const expiresAt = now + (options.ttlMs ?? this.defaultTtlMs);

    const preview: TransactionPreview = {
      transactionId,
      patches: validatedPatches,
      status: "prepared",
      createdAt: now,
      expiresAt,
    };

    this.transactions.set(transactionId, { preview });
    return preview;
  }

  /** Retrieves an active transaction preview by transactionId if not expired. */
  getPreview(transactionId: string): TransactionPreview | undefined {
    this.purgeExpired();
    const entry = this.transactions.get(transactionId);
    return entry?.preview;
  }

  /** Discards an active transaction and drops it from in-memory storage. */
  discardTransaction(transactionId: string): boolean {
    const entry = this.transactions.get(transactionId);
    if (!entry) {
      return false;
    }
    entry.preview.status = "discarded";
    this.transactions.delete(transactionId);
    return true;
  }

  /** Applies a prepared transaction using a journaled, recoverable multi-file execution with pre-write drift detection and automated rollback. */
  async applyTransaction(
    transactionId: string,
    options: ApplyTransactionOptions,
  ): Promise<ApplyResult> {
    if (options.confirm !== true) {
      return {
        transactionId,
        status: "error",
        code: "confirmation_required",
        filesModified: [],
        error: "Confirmation required: set confirm=true to apply transaction.",
      };
    }

    const preview = this.getPreview(transactionId);
    if (!preview) {
      return {
        transactionId,
        status: "error",
        code: "transaction_not_found",
        filesModified: [],
        error: `Transaction '${transactionId}' was not found or has expired.`,
      };
    }

    if (preview.status !== "prepared") {
      return {
        transactionId,
        status: "error",
        code: "transaction_not_prepared",
        filesModified: [],
        error: `Transaction '${transactionId}' is in '${preview.status}' status and cannot be applied.`,
      };
    }

    const readFn = options.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
    const writeFn = options.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, "utf-8"));

    // Step 1: Pre-write validation (containment, symlinks, content drift TOCTOU checks)
    const driftError = this.validatePreWritePatches(preview.patches, options.projectRoot, readFn, transactionId);
    if (driftError !== undefined) {
      return driftError;
    }

    // Step 2: Journaled multi-file application with atomic replacement and automated rollback
    const applyError = this.executeJournaledApply(preview.patches, options.projectRoot, writeFn, transactionId);
    if (applyError !== undefined) {
      preview.status = "discarded";
      this.transactions.delete(transactionId);
      return applyError;
    }

    preview.status = "applied";
    this.transactions.delete(transactionId);
    const filesModified = preview.patches.map((p) => p.file);

    // Step 3: Post-apply automatic verification
    return await this.runPostApplyVerification(filesModified, options.onPostCheck, transactionId);
  }

  private validatePreWritePatches(
    patches: readonly FilePatch[],
    projectRoot: string,
    readFn: (path: string) => string,
    transactionId: string,
  ): ApplyResult | undefined {
    for (const patch of patches) {
      try {
        validateHookPath(patch.file, projectRoot);
      } catch (pathError: unknown) {
        const message = pathError instanceof Error ? pathError.message : String(pathError);
        return {
          transactionId,
          status: "error",
          code: "path_outside_project",
          filesModified: [],
          message,
          error: message,
        };
      }

      const fullPath = resolve(projectRoot, patch.file);
      const exists = existsSync(fullPath);

      if (exists) {
        const currentContent = readFn(fullPath);
        const currentHash = computeContentHash(currentContent);
        const expectedHash = patch.originalHash ?? computeContentHash(patch.originalContent);

        if (currentHash !== expectedHash || currentContent !== patch.originalContent) {
          const message = `File '${patch.file}' content has drifted: has been modified on disk since the preview was generated. Transaction aborted to prevent data loss.`;
          return {
            transactionId,
            status: "error",
            code: "file_drift_detected",
            filesModified: [],
            message,
            error: message,
          };
        }
      } else if (patch.originalContent !== "") {
        const message = `Expected file does not exist on disk: ${patch.file}`;
        return {
          transactionId,
          status: "error",
          code: "file_drift_detected",
          filesModified: [],
          message,
          error: message,
        };
      }
    }
    return undefined;
  }

  private executeJournaledApply(
    patches: readonly FilePatch[],
    projectRoot: string,
    writeFn: (path: string, content: string) => void,
    transactionId: string,
  ): ApplyResult | undefined {
    const journal: JournalEntry[] = [];
    for (const patch of patches) {
      const fullPath = resolve(projectRoot, patch.file);
      const existed = existsSync(fullPath);
      const originalContent = existed ? readFileSync(fullPath, "utf-8") : "";
      journal.push({
        file: patch.file,
        fullPath,
        existed,
        originalContent,
        applied: false,
      });
    }

    try {
      for (let i = 0; i < patches.length; i++) {
        const patch = patches[i]!;
        const entry = journal[i]!;
        atomicWriteFile(entry.fullPath, patch.patchedContent, writeFn);
        entry.applied = true;
      }
      return undefined;
    } catch (writeError: unknown) {
      this.rollbackJournal(journal, writeFn);
      const errorMessage = writeError instanceof Error ? writeError.message : String(writeError);
      return {
        transactionId,
        status: "rolled_back",
        code: "transaction_aborted_and_rolled_back",
        filesModified: [],
        message: `Transaction aborted and rolled back: ${errorMessage}`,
        error: errorMessage,
      };
    }
  }

  private rollbackJournal(
    journal: readonly JournalEntry[],
    writeFn: (path: string, content: string) => void,
  ): void {
    for (let i = journal.length - 1; i >= 0; i--) {
      const entry = journal[i];
      if (entry && entry.applied) {
        try {
          if (entry.existed) {
            atomicWriteFile(entry.fullPath, entry.originalContent, writeFn);
          } else if (existsSync(entry.fullPath)) {
            rmSync(entry.fullPath, { force: true });
          }
        } catch {
          // Best effort rollback
        }
      }
    }
  }

  private async runPostApplyVerification(
    filesModified: string[],
    onPostCheck: ApplyTransactionOptions["onPostCheck"],
    transactionId: string,
  ): Promise<ApplyResult> {
    let postCheckId: string | undefined;
    let delta: unknown | undefined;
    let message: string | undefined;

    if (onPostCheck !== undefined) {
      try {
        const checkResult = await onPostCheck(filesModified);
        postCheckId = checkResult.postCheckId;
        delta = checkResult.delta;
        message = checkResult.message;
      } catch (checkError: unknown) {
        postCheckId = undefined;
        delta = { error: checkError instanceof Error ? checkError.message : String(checkError) };
      }
    }

    return {
      transactionId,
      status: "success",
      filesModified,
      ...(postCheckId !== undefined ? { postCheckId } : {}),
      ...(delta !== undefined ? { delta } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.transactions.entries()) {
      if (entry.preview.expiresAt <= now) {
        this.transactions.delete(id);
      }
    }
  }
}
