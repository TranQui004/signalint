import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readSessionLogTail,
  rotateSessionLogIfNeeded,
} from "../src/memory/sessionLogStorage.js";

const fixtureRoot = resolve(".signalint/test/session-log-storage");

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("session log storage", () => {
  it("reads recent entries backwards across multiple chunks", async () => {
    const logPath = resolve(fixtureRoot, "chunked.jsonl");
    const lines = [1, 2, 3, 4].map((id) =>
      JSON.stringify({ id, padding: "x".repeat(70_000) }),
    );
    await writeFixture(logPath, `${lines.join("\n")}\n`);

    const tail = readSessionLogTail(logPath, 2, 300_000);

    expect(tail?.endsWithNewline).toBe(true);
    expect(tail?.serialized.split("\n")).toEqual(lines.slice(-2));
  });

  it("discards a partial first line when the byte window starts mid-entry", async () => {
    const logPath = resolve(fixtureRoot, "partial.jsonl");
    const recent = ['{"id":2}', '{"id":3}'];
    await writeFixture(logPath, `${"x".repeat(200)}\n${recent.join("\n")}\n`);

    const tail = readSessionLogTail(logPath, 10, 40);

    expect(tail?.serialized).toBe(recent.join("\n"));
  });

  it("returns no partial entry when maxBytes is too small for one line", async () => {
    const logPath = resolve(fixtureRoot, "tiny-window.jsonl");
    await writeFixture(logPath, `${"x".repeat(100)}\n`);

    const tail = readSessionLogTail(logPath, 5, 1);

    expect(tail).toEqual({ endsWithNewline: true, serialized: "" });
  });

  it("rotates only when the pending write exceeds the exact byte boundary", async () => {
    const logPath = resolve(fixtureRoot, "boundary.jsonl");
    await writeFixture(logPath, "one\n");

    expect(await rotateSessionLogIfNeeded(logPath, 6, 4, 10)).toBe(false);
    await expect(stat(`${logPath}.1`)).rejects.toMatchObject({ code: "ENOENT" });

    expect(await rotateSessionLogIfNeeded(logPath, 7, 4, 10)).toBe(true);
    expect(await readFile(`${logPath}.1`, "utf8")).toBe("one\n");
    expect(await readFile(logPath, "utf8")).toBe("one\n");
  });

  it("preserves a truncated final line for tolerant parsing and append repair", async () => {
    const logPath = resolve(fixtureRoot, "truncated.jsonl");
    await writeFixture(logPath, '{"timestamp":1}\n{"timestamp":');

    const tail = readSessionLogTail(logPath, 5, 1024);

    expect(tail).toEqual({
      endsWithNewline: false,
      serialized: '{"timestamp":1}\n{"timestamp":',
    });
  });
});

async function writeFixture(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
