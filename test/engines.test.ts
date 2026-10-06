import { describe, expect, it } from "vitest";

import { ALL_ENGINES, ENGINE_REGISTRY, getEngineSpec } from "../src/engines/registry.js";
import type { IssueEngine } from "../src/schema.js";

describe("Engine registry", () => {
  it("registers all expected issue engines with complete specifications", () => {
    const expectedEngines: IssueEngine[] = ["oxlint", "tsc", "biome", "eslint"];
    expect([...ALL_ENGINES].sort()).toEqual([...expectedEngines].sort());

    for (const engine of expectedEngines) {
      const spec = getEngineSpec(engine);
      expect(ENGINE_REGISTRY[engine]).toBe(spec);
      expect(spec.id).toBe(engine);
      expect(typeof spec.displayName).toBe("string");
      expect(typeof spec.packageName).toBe("string");
      expect(typeof spec.binRelativePath).toBe("string");
      expect(typeof spec.bundledAvailable).toBe("boolean");
      expect(Array.isArray(spec.configFiles)).toBe(true);
      expect(typeof spec.isRelevant).toBe("function");
      expect(typeof spec.run).toBe("function");
      expect(typeof spec.isWholeProgram).toBe("boolean");
      expect(typeof spec.defaultEnabled).toBe("boolean");
    }
  });

  it("retrieves engine spec by id and throws for unknown engine", () => {
    expect(getEngineSpec("tsc").displayName).toBe("TypeScript");
    expect(getEngineSpec("oxlint").displayName).toBe("Oxlint");
    expect(getEngineSpec("biome").displayName).toBe("Biome");
    expect(getEngineSpec("eslint").displayName).toBe("ESLint");

    expect(() => getEngineSpec("unknown" as unknown as IssueEngine)).toThrow(
      "Unknown engine: unknown",
    );
  });

  it("correctly identifies file relevance for each engine", () => {
    const oxlint = getEngineSpec("oxlint");
    const tsc = getEngineSpec("tsc");
    const biome = getEngineSpec("biome");
    const eslint = getEngineSpec("eslint");

    expect(oxlint.isRelevant("src/index.ts")).toBe(true);
    expect(oxlint.isRelevant("src/component.jsx")).toBe(true);
    expect(oxlint.isRelevant("schema.json")).toBe(false);

    expect(tsc.isRelevant("src/index.ts")).toBe(true);
    expect(tsc.isRelevant("tsconfig.json")).toBe(true);
    expect(tsc.isRelevant("package.json")).toBe(true);
    expect(tsc.isRelevant("styles.css")).toBe(false);

    expect(biome.isRelevant("src/index.ts")).toBe(true);
    expect(biome.isRelevant("styles.css")).toBe(true);
    expect(biome.isRelevant("query.graphql")).toBe(true);

    expect(eslint.isRelevant("src/index.ts")).toBe(true);
    expect(eslint.isRelevant("styles.css")).toBe(false);
  });
});
