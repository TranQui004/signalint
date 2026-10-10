/**
 * Defines types and structures for in-memory transactional previews and safe atomic apply.
 */

export interface FilePatch {
  file: string;
  originalContent: string;
  patchedContent: string;
  description?: string | undefined;
}

export type TransactionStatus = "prepared" | "applied" | "discarded";

export interface TransactionPreview {
  transactionId: string;
  patches: FilePatch[];
  status: TransactionStatus;
  createdAt: number;
  expiresAt: number;
}

export type ApplyStatus = "success" | "rolled_back" | "error";

export interface ApplyResult {
  transactionId: string;
  status: ApplyStatus;
  filesModified: string[];
  postCheckId?: string | undefined;
  delta?: unknown;
  message?: string | undefined;
  error?: string | undefined;
}

export interface PrepareTransactionOptions {
  projectRoot: string;
  ttlMs?: number | undefined;
}

export interface ApplyTransactionOptions {
  projectRoot: string;
  confirm: boolean;
  onPostCheck?: ((modifiedFiles: string[]) => Promise<{ postCheckId?: string | undefined; delta?: unknown; message?: string | undefined }>) | undefined;
  writeFile?: ((path: string, content: string) => void) | undefined;
  readFile?: ((path: string) => string) | undefined;
}
