import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

interface BackupFile {
  path: string;
  existed: boolean;
  content: string;
}

/**
 * Manages in-memory previews and atomic reversible transactions for code modifications.
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
      return {
        file: normalizedPath,
        originalContent: patch.originalContent,
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

  /** Atomically applies a prepared transaction with rollback on write failure and drift verification. */
  async applyTransaction(
    transactionId: string,
    options: ApplyTransactionOptions,
  ): Promise<ApplyResult> {
    if (options.confirm !== true) {
      return {
        transactionId,
        status: "error",
        filesModified: [],
        error: "Confirmation required: set confirm=true to apply transaction.",
      };
    }

    const preview = this.getPreview(transactionId);
    if (!preview) {
      return {
        transactionId,
        status: "error",
        filesModified: [],
        error: `Transaction '${transactionId}' was not found or has expired.`,
      };
    }

    if (preview.status !== "prepared") {
      return {
        transactionId,
        status: "error",
        filesModified: [],
        error: `Transaction '${transactionId}' is in '${preview.status}' status and cannot be applied.`,
      };
    }

    const readFn = options.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
    const writeFn = options.writeFile ?? ((p: string, c: string) => writeFileSync(p, c, "utf-8"));

    // Step 1: Drift check against current filesystem content
    for (const patch of preview.patches) {
      const fullPath = resolve(options.projectRoot, patch.file);
      const exists = existsSync(fullPath);
      if (exists) {
        const currentContent = readFn(fullPath);
        if (currentContent !== patch.originalContent) {
          return {
            transactionId,
            status: "error",
            filesModified: [],
            error: `File content has drifted since transaction was prepared: ${patch.file}`,
          };
        }
      } else if (patch.originalContent !== "") {
        return {
          transactionId,
          status: "error",
          filesModified: [],
          error: `Expected file does not exist on disk: ${patch.file}`,
        };
      }
    }

    // Step 2: Atomic apply with automatic rollback
    const backups: BackupFile[] = [];
    try {
      for (const patch of preview.patches) {
        const fullPath = resolve(options.projectRoot, patch.file);
        const existed = existsSync(fullPath);
        const originalDiskContent = existed ? readFn(fullPath) : "";
        backups.push({ path: fullPath, existed, content: originalDiskContent });

        mkdirSync(dirname(fullPath), { recursive: true });
        writeFn(fullPath, patch.patchedContent);
      }
    } catch (writeError: unknown) {
      // Rollback all written files in reverse order
      for (let i = backups.length - 1; i >= 0; i--) {
        const backup = backups[i];
        if (backup) {
          try {
            if (backup.existed) {
              writeFn(backup.path, backup.content);
            } else if (existsSync(backup.path)) {
              rmSync(backup.path, { force: true });
            }
          } catch {
            // Best effort rollback
          }
        }
      }
      preview.status = "discarded";
      this.transactions.delete(transactionId);
      return {
        transactionId,
        status: "rolled_back",
        filesModified: [],
        error: writeError instanceof Error ? writeError.message : String(writeError),
      };
    }

    preview.status = "applied";
    this.transactions.delete(transactionId);
    const filesModified = preview.patches.map((p) => p.file);

    // Step 3: Post-apply automatic verification
    let postCheckId: string | undefined;
    let delta: unknown | undefined;
    let message: string | undefined;
    if (options.onPostCheck !== undefined) {
      try {
        const checkResult = await options.onPostCheck(filesModified);
        postCheckId = checkResult.postCheckId;
        delta = checkResult.delta;
        message = checkResult.message;
      } catch (checkError: unknown) {
        // Post-check error does not roll back an intentionally applied patch, but captures the warning
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
