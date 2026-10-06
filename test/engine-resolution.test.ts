import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearEngineResolutionCache,
  resolveEngine,
  resolveEngineVersion,
} from "../src/engineResolution.js";

describe("Engine resolution", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    clearEngineResolutionCache();
  });

  afterEach(async () => {
    clearEngineResolutionCache();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("falls back to bundled engines when project has no dependencies", () => {
    const emptyProject = resolve("test/fixtures/fresh-install-project");
    const oxlint = resolveEngine("oxlint", emptyProject);
    const tsc = resolveEngine("tsc", emptyProject);
    const biome = resolveEngine("biome", emptyProject);
    const eslint = resolveEngine("eslint", emptyProject);

    expect(oxlint).toBeDefined();
    expect(oxlint?.isProjectLocal).toBe(false);
    expect(tsc).toBeDefined();
    expect(tsc?.isProjectLocal).toBe(false);
    expect(biome).toBeDefined();
    expect(biome?.isProjectLocal).toBe(false);
    expect(eslint).toBeUndefined();

    expect(resolveEngineVersion("oxlint", emptyProject)).not.toBe("0.0.0");
    expect(resolveEngineVersion("tsc", emptyProject)).toBe("7.0.2");
    expect(resolveEngineVersion("eslint", emptyProject)).toBe("0.0.0");
  });

  it("resolves project-local engines when installed in node_modules", async () => {
    const tempProject = join(tmpdir(), `signalint-res-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempDirs.push(tempProject);
    await mkdir(resolve(tempProject, "node_modules", "eslint", "bin"), { recursive: true });
    await writeFile(
      resolve(tempProject, "package.json"),
      JSON.stringify({ name: "mock-project" }),
      "utf8",
    );
    await writeFile(
      resolve(tempProject, "node_modules", "eslint", "package.json"),
      JSON.stringify({
        name: "eslint",
        version: "9.18.0",
        bin: { eslint: "bin/eslint.js" },
      }),
      "utf8",
    );
    await writeFile(
      resolve(tempProject, "node_modules", "eslint", "bin", "eslint.js"),
      "#!/usr/bin/env node\n",
      "utf8",
    );

    const resolved = resolveEngine("eslint", tempProject);
    expect(resolved).toBeDefined();
    expect(resolved?.isProjectLocal).toBe(true);
    expect(resolved?.version).toBe("9.18.0");
    expect(resolved?.binPath).toContain("eslint.js");
    expect(resolveEngineVersion("eslint", tempProject)).toBe("9.18.0");
  });

  it("caches resolved engines per project and clearEngineResolutionCache resets it", async () => {
    const emptyProject = resolve("test/fixtures/fresh-install-project");
    const first = resolveEngine("oxlint", emptyProject);
    const second = resolveEngine("oxlint", emptyProject);
    expect(first).toBe(second);

    clearEngineResolutionCache();
    const third = resolveEngine("oxlint", emptyProject);
    expect(third).not.toBe(first);
    expect(third).toEqual(first);
  });
});
