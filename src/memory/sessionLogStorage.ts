import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import {
  mkdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

const READ_CHUNK_BYTES = 64 * 1024;

export interface SessionLogTail {
  endsWithNewline: boolean;
  serialized: string;
}

/** Reads at most the newest requested JSONL lines without loading the full file. */
export function readSessionLogTail(
  logPath: string,
  maxEntries: number,
  maxBytes: number,
): SessionLogTail | undefined {
  assertPositiveInteger(maxEntries, "maxEntries");
  assertPositiveInteger(maxBytes, "maxBytes");
  let descriptor: number;
  try {
    descriptor = openSync(logPath, "r");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    const fileSize = fstatSync(descriptor).size;
    if (fileSize === 0) {
      return { endsWithNewline: false, serialized: "" };
    }
    const tail = readTailBytes(descriptor, fileSize, maxEntries, maxBytes);
    const serialized = discardPartialFirstLine(tail.bytes.toString("utf8"), tail.offset);
    return {
      endsWithNewline: tail.bytes[tail.bytes.length - 1] === 0x0a,
      serialized: takeRecentNonEmptyLines(serialized, maxEntries),
    };
  } finally {
    closeSync(descriptor);
  }
}

/** Rotates an oversized JSONL file, retaining a bounded recent tail and one backup. */
export async function rotateSessionLogIfNeeded(
  logPath: string,
  pendingBytes: number,
  maxEntries: number,
  maxBytes: number,
): Promise<boolean> {
  assertNonNegativeInteger(pendingBytes, "pendingBytes");
  assertPositiveInteger(maxEntries, "maxEntries");
  assertPositiveInteger(maxBytes, "maxBytes");
  const currentSize = await readFileSize(logPath);
  if (currentSize === undefined || currentSize + pendingBytes <= maxBytes) {
    return false;
  }

  const tail = readSessionLogTail(logPath, maxEntries, maxBytes);
  const rotatedPath = `${logPath}.1`;
  await mkdir(dirname(logPath), { recursive: true });
  await rm(rotatedPath, { force: true });
  const archived = normalizeSerializedTail(tail?.serialized);
  await writeFile(rotatedPath, archived, "utf8");
  const retained = takeRecentNonEmptyLines(archived, maxEntries - 1);
  await writeFile(logPath, normalizeSerializedTail(retained), "utf8");
  return true;
}

interface TailBytes {
  bytes: Buffer;
  offset: number;
}

function readTailBytes(
  descriptor: number,
  fileSize: number,
  maxEntries: number,
  maxBytes: number,
): TailBytes {
  const chunks: Buffer[] = [];
  const targetNewlines = maxEntries + 1;
  let newlines = 0;
  let position = fileSize;
  let bytesRead = 0;

  while (position > 0 && newlines < targetNewlines && bytesRead < maxBytes) {
    const length = Math.min(READ_CHUNK_BYTES, position, maxBytes - bytesRead);
    position -= length;
    const chunk = Buffer.allocUnsafe(length);
    readSync(descriptor, chunk, 0, length, position);
    chunks.unshift(chunk);
    newlines += countNewlines(chunk);
    bytesRead += length;
  }

  return { bytes: Buffer.concat(chunks), offset: position };
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) {
    if (byte === 0x0a) {
      count += 1;
    }
  }
  return count;
}

function discardPartialFirstLine(serialized: string, offset: number): string {
  if (offset === 0) {
    return serialized;
  }
  const firstNewline = serialized.indexOf("\n");
  return firstNewline === -1 ? "" : serialized.slice(firstNewline + 1);
}

function takeRecentNonEmptyLines(serialized: string, maxEntries: number): string {
  if (maxEntries === 0) {
    return "";
  }
  return serialized
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-maxEntries)
    .join("\n");
}

function normalizeSerializedTail(serialized: string | undefined): string {
  const trimmed = serialized?.trim();
  return trimmed === undefined || trimmed === "" ? "" : `${trimmed}\n`;
}

async function readFileSize(logPath: string): Promise<number | undefined> {
  try {
    return (await stat(logPath)).size;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
