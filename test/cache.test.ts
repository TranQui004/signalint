import { performance } from "node:perf_hooks";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCacheKey, SqliteCache } from "../src/cache/sqliteCache.js";
import {
  checkFiles,
  checkFilesWithStats,
  computeEngineConfigHash,
  type CacheEngine,
} from "../src/checkFiles.js";
import {
  createIssueId,
  type IssueEngine,
  type NormalizedIssue,
} from "../src/schema.js";

const fixtureRoot = resolve("test/fixtures/cache-project");
const openCaches: SqliteCache[] = [];

afterEach(() => {
  for (const cache of openCaches) {
    cache.close();
  }
  openCaches.length = 0;
});

describe("SQLite cache", () => {
  it("stores normalized issues under the Section 9 key", () => {
    const cache = createMemoryCache();
    const issue = makeIssue("src/file01.ts", "oxlint");
    const key = createCacheKey("content", "oxlint", "config-a");

    cache.set(key, [issue]);

    expect(cache.get(key)).toEqual([issue]);
    expect(cache.get(createCacheKey("changed", "oxlint", "config-a"))).toBeUndefined();
  });

  it("invalidates only stale entries for the selected engine", () => {
    const cache = createMemoryCache();
    const oldOxlintKey = createCacheKey("content", "oxlint", "config-a");
    const currentOxlintKey = createCacheKey("other", "oxlint", "config-b");
    const tscKey = createCacheKey("content", "tsc", "config-a");
    cache.set(oldOxlintKey, []);
    cache.set(currentOxlintKey, []);
    cache.set(tscKey, []);
    cache.setEngineResult("oxlint", "config-a", [makeIssue("src/file01.ts", "oxlint")]);

    expect(cache.invalidateEngine("oxlint", "config-b")).toBe(1);
    expect(cache.get(oldOxlintKey)).toBeUndefined();
    expect(cache.get(currentOxlintKey)).toEqual([]);
    expect(cache.get(tscKey)).toEqual([]);
    expect(cache.getEngineResult("oxlint", "config-b")).toBeUndefined();
  });

  it("changes the engine config hash when a recognized config is edited", async () => {
    const configPath = resolve(fixtureRoot, ".oxlintrc.json");
    const original = await readFile(configPath, "utf8");
    const before = await computeEngineConfigHash("oxlint", fixtureRoot);

    try {
      await writeFile(configPath, `${original.trimEnd()}\n `, "utf8");
      const after = await computeEngineConfigHash("oxlint", fixtureRoot);
      expect(after).not.toBe(before);
    } finally {
      await writeFile(configPath, original, "utf8");
    }
  });

  it("reruns only the engine whose config hash changed", async () => {
    const cache = createMemoryCache();
    const checkedFiles = ["src/generated/file01.ts"];
    const oxlintRunner = vi.fn(createRunner("oxlint"));
    const tscRunner = vi.fn(createWholeProgramRunner());
    const runners = { oxlint: oxlintRunner, tsc: tscRunner };
    await checkFiles(checkedFiles, { cwd: fixtureRoot, cache, runners });
    oxlintRunner.mockClear();
    tscRunner.mockClear();

    const configPath = resolve(fixtureRoot, ".oxlintrc.json");
    const original = await readFile(configPath, "utf8");
    try {
      await writeFile(configPath, `${original.trimEnd()}\n `, "utf8");
      await checkFiles(checkedFiles, { cwd: fixtureRoot, cache, runners });
    } finally {
      await writeFile(configPath, original, "utf8");
    }

    expect(oxlintRunner).toHaveBeenCalledTimes(1);
    expect(oxlintRunner.mock.calls[0]?.[0]).toEqual(checkedFiles);
    expect(tscRunner).not.toHaveBeenCalled();
  });

  it("routes TypeScript config changes to tsc without passing them to Oxlint", async () => {
    const cache = createMemoryCache();
    const oxlintRunner = vi.fn(createRunner("oxlint"));
    const tscRunner = vi.fn(createWholeProgramRunner());

    await checkFiles(["tsconfig.json"], {
      cwd: fixtureRoot,
      cache,
      runners: { oxlint: oxlintRunner, tsc: tscRunner },
    });

    expect(oxlintRunner).not.toHaveBeenCalled();
    expect(tscRunner).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 2 acceptance benchmark", () => {
  it("rechecks two hits and one changed file under 300ms with per-engine call rules", async () => {
    const fixtureFiles = await listTypeScriptFiles();
    expect(fixtureFiles).toHaveLength(50);
    const checkedFiles = fixtureFiles.slice(0, 3);
    const changedFile = checkedFiles[2];
    if (changedFile === undefined) {
      throw new Error("The cache benchmark fixture did not contain three files.");
    }

    const cache = createMemoryCache();
    const oxlintRunner = vi.fn(createRunner("oxlint"));
    const tscRunner = vi.fn(createWholeProgramRunner());
    const runners = { oxlint: oxlintRunner, tsc: tscRunner };
    await checkFiles(checkedFiles, { cwd: fixtureRoot, cache, runners });
    oxlintRunner.mockClear();
    tscRunner.mockClear();

    const unchangedResult = await checkFilesWithStats(checkedFiles, {
      cwd: fixtureRoot,
      cache,
      runners,
    });
    expect(oxlintRunner).not.toHaveBeenCalled();
    expect(tscRunner).not.toHaveBeenCalled();
    expect(unchangedResult.cache).toEqual({ hits: 6, misses: 0 });
    oxlintRunner.mockClear();
    tscRunner.mockClear();

    const changedPath = resolve(fixtureRoot, changedFile);
    const original = await readFile(changedPath, "utf8");
    let elapsedMs = Number.POSITIVE_INFINITY;
    try {
      await writeFile(changedPath, `${original}\nexport const cacheMiss = true;\n`, "utf8");
      const startedAt = performance.now();
      const changedResult = await checkFilesWithStats(checkedFiles, {
        cwd: fixtureRoot,
        cache,
        runners,
      });
      elapsedMs = performance.now() - startedAt;
      expect(changedResult.cache).toEqual({ hits: 4, misses: 2 });
    } finally {
      await writeFile(changedPath, original, "utf8");
    }

    expect(elapsedMs).toBeLessThan(300);
    expect(oxlintRunner).toHaveBeenCalledTimes(1);
    expect(tscRunner).toHaveBeenCalledTimes(1);
    expect(oxlintRunner.mock.calls[0]?.[0]).toEqual([changedFile]);
    console.info(
      `Phase 2 benchmark: ${elapsedMs.toFixed(2)}ms; ` +
        `oxlint calls=${String(oxlintRunner.mock.calls.length)}; ` +
        `tsc whole-project calls=${String(tscRunner.mock.calls.length)}; ` +
        `unchanged tsc calls=0; changed=${changedFile}`,
    );
  });
});

function createMemoryCache(): SqliteCache {
  const cache = new SqliteCache(":memory:");
  openCaches.push(cache);
  return cache;
}

async function listTypeScriptFiles(): Promise<string[]> {
  const generatedDirectory = resolve(fixtureRoot, "src/generated");
  const generated = (await readdir(generatedDirectory))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => `src/generated/${file}`);
  return ["src/index.ts", ...generated].sort();
}

function createRunner(engine: CacheEngine) {
  return async (files: readonly string[]): Promise<NormalizedIssue[]> =>
    files.map((file) => makeIssue(file, engine));
}

function createWholeProgramRunner() {
  return async (): Promise<NormalizedIssue[]> => [makeIssue("src/index.ts", "tsc")];
}

function makeIssue(file: string, engine: IssueEngine): NormalizedIssue {
  const rule = engine === "tsc" ? "TS9999" : "fixture-rule";
  const message = "Fixture diagnostic";
  return {
    issueId: createIssueId(file, rule, 1, message),
    file,
    line: 1,
    col: 1,
    engine,
    rule,
    severity: "warning",
    message,
    fixable: false,
  };
}
