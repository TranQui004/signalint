import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteCache } from "../src/cache/sqliteCache.js";
import { checkFilesWithStats } from "../src/checkFiles.js";
import { checkProject } from "../src/index.js";
import { createIssueId, type NormalizedIssue } from "../src/schema.js";

const cacheFixtureRoot = resolve("test/fixtures/cache-project");
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {}),
    ),
  );
});

describe("engine fan-out", () => {
  it("preserves check_files diagnostics when another engine rejects", async () => {
    const cache = new SqliteCache(":memory:");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await checkFilesWithStats(["src/generated/file01.ts"], {
        cwd: cacheFixtureRoot,
        cache,
        engines: { oxlint: true, tsc: true, biome: false, eslint: false },
        runners: {
          oxlint: async (files) => files.map(makeOxlintIssue),
          tsc: () => Promise.reject(new Error("fixture tsc failure")),
        },
      });

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.engine).toBe("oxlint");
      expect(result.engines).toEqual({
        oxlint: { status: "ok" },
        tsc: { status: "error", message: "fixture tsc failure" },
        biome: { status: "disabled" },
        eslint: { status: "disabled" },
      });
    } finally {
      cache.close();
    }
  });

  it("returns a schema 1.1 partial project result through real adapters", async () => {
    const partialProjectRoot = await mkdtemp(resolve(tmpdir(), "signalint-partial-"));
    temporaryRoots.push(partialProjectRoot);
    await mkdir(resolve(partialProjectRoot, "src"), { recursive: true });
    await writeFile(
      resolve(partialProjectRoot, "signalint.config.json"),
      JSON.stringify({
        engines: { oxlint: true, tsc: true, biome: false, eslint: false },
        ignore: [],
      }),
      "utf8",
    );
    await writeFile(
      resolve(partialProjectRoot, "src", "broken.ts"),
      "const unused = 1;\nexport const value = 2;\n",
      "utf8",
    );
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const response = await checkProject(["."], partialProjectRoot);

    expect(response.schemaVersion).toBe("1.4");
    expect(response.status).toBe("error");
    expect(response.code).toBe("engine_failed");
    expect(response.totalIssues).toBeGreaterThan(0);
    expect(response.engines.oxlint).toEqual({ status: "ok" });
    expect(response.engines.tsc?.status).toBe("error");
    expect(response.engines.biome).toBeUndefined();
    expect(response.engines.eslint).toBeUndefined();
  });
});

function makeOxlintIssue(file: string): NormalizedIssue {
  const rule = "fixture-rule";
  const message = "Fixture diagnostic";
  return {
    issueId: createIssueId(file, rule, 1, message),
    file,
    line: 1,
    col: 1,
    engine: "oxlint",
    rule,
    severity: "warning",
    message,
    fixable: false,
  };
}
