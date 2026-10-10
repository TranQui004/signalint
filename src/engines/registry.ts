import { FLAT_ESLINT_CONFIG_FILES } from "../config.js";
import type { BuiltinEngine, NormalizedIssue } from "../schema.js";
import { runBiome, type BiomeRunOptions } from "./biome.js";
import { runEslint, type EslintRunOptions } from "./eslint.js";
import { runOxlint, type OxlintRunOptions } from "./oxlint.js";
import { runTsc, type TscRunOptions } from "./tsc.js";

export interface EngineRunOptions {
  cwd?: string | undefined;
  includeFormatter?: boolean | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export type EngineRunner = (
  files: readonly string[],
  options?: EngineRunOptions,
) => Promise<NormalizedIssue[]>;

export interface EngineSpec {
  id: BuiltinEngine;
  displayName: string;
  packageName: string;
  binRelativePath: string;
  bundledAvailable: boolean;
  configFiles: readonly string[];
  isRelevant: (file: string) => boolean;
  run: EngineRunner;
  isWholeProgram: boolean;
  defaultEnabled: boolean;
  versionSource: "packageJson";
}

export const ENGINE_REGISTRY: Record<BuiltinEngine, EngineSpec> = {
  oxlint: {
    id: "oxlint",
    displayName: "Oxlint",
    packageName: "oxlint",
    binRelativePath: "bin/oxlint",
    bundledAvailable: true,
    configFiles: [".oxlintrc", ".oxlintrc.json", "oxlint.json"],
    isRelevant: (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file),
    run: (files, options) => runOxlint(files, options as OxlintRunOptions),
    isWholeProgram: false,
    defaultEnabled: true,
    versionSource: "packageJson",
  },
  tsc: {
    id: "tsc",
    displayName: "TypeScript",
    packageName: "typescript",
    binRelativePath: "bin/tsc",
    bundledAvailable: true,
    configFiles: ["tsconfig.json"],
    isRelevant: (file: string): boolean =>
      /\.(?:[cm]?[jt]sx?|json)$/.test(file) ||
      file.endsWith("/package.json") ||
      file === "package.json",
    run: (files, options) => runTsc(files, options as TscRunOptions),
    isWholeProgram: true,
    defaultEnabled: true,
    versionSource: "packageJson",
  },
  biome: {
    id: "biome",
    displayName: "Biome",
    packageName: "@biomejs/biome",
    binRelativePath: "bin/biome",
    bundledAvailable: true,
    configFiles: ["biome.json", "biome.jsonc"],
    isRelevant: (file: string): boolean =>
      /\.(?:[cm]?[jt]sx?|jsonc?|css|g(?:raph)?ql)$/.test(file),
    run: (files, options) => runBiome(files, options as BiomeRunOptions),
    isWholeProgram: false,
    defaultEnabled: false,
    versionSource: "packageJson",
  },
  eslint: {
    id: "eslint",
    displayName: "ESLint",
    packageName: "eslint",
    binRelativePath: "bin/eslint.js",
    bundledAvailable: false,
    configFiles: FLAT_ESLINT_CONFIG_FILES,
    isRelevant: (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file),
    run: (files, options) => runEslint(files, options as EslintRunOptions),
    isWholeProgram: false,
    defaultEnabled: false,
    versionSource: "packageJson",
  },
};

export const ALL_ENGINES: readonly BuiltinEngine[] = Object.keys(
  ENGINE_REGISTRY,
) as BuiltinEngine[];

/** Retrieves the specification for a registered diagnostics engine. */
export function getEngineSpec(engine: BuiltinEngine): EngineSpec {
  const spec = ENGINE_REGISTRY[engine];
  if (!spec) {
    throw new Error(`Unknown engine: ${engine}`);
  }
  return spec;
}
