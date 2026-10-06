import { readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { CLIENT_REGISTRY, getLegacyAntigravityConfigPath, type McpClientSpec } from "./clients/registry.js";
import { canonicalizePath, readCanonicalProjectRoot } from "./projectPaths.js";
import { isRecord } from "./util/index.js";

export interface DoctorOptions {
  cwd?: string | undefined;
  homeDir?: string | undefined;
  writeOutput?: ((message: string) => void) | undefined;
}

interface EngineInfo {
  name: string;
  source: "project" | "bundled" | "not_installed";
  version: string | undefined;
}

interface StaleCwdFinding {
  client: McpClientSpec;
  configPath: string;
  configuredCwd: string;
  currentProjectRoot: string;
}

/** Diagnoses project configuration, engine availability, and MCP client entries. */
export async function runDoctorCommand(options: DoctorOptions = {}): Promise<number> {
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(message));
  const homeDirectory = resolve(options.homeDir ?? homedir());

  let projectRoot: string;
  try {
    projectRoot = await readCanonicalProjectRoot(options.cwd ?? process.cwd());
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    writeOutput(`Error: Could not resolve project root: ${message}\n`);
    return 1;
  }

  writeOutput(`=== Signalint Doctor ===\n\n`);
  writeOutput(`Project root: ${projectRoot}\n\n`);

  let hasBlockingProblem = false;

  // 1. Check signalint.config.json
  const hasConfigFile = await pathExists(resolve(projectRoot, "signalint.config.json"));
  if (hasConfigFile) {
    writeOutput(`[OK] Configuration: signalint.config.json found.\n`);
  } else {
    hasBlockingProblem = true;
    writeOutput(`[ERROR] Configuration: signalint.config.json is missing in ${projectRoot}.\n`);
    writeOutput(`  Fix: Run 'npx signalint-mcp init' in ${projectRoot} before running checks.\n`);
  }

  // 2. Check project markers
  const isJsProject = await hasJsProjectMarkers(projectRoot);
  if (isJsProject) {
    writeOutput(`[OK] Project markers: JavaScript/TypeScript project detected.\n`);
  } else {
    hasBlockingProblem = true;
    writeOutput(`[ERROR] Project markers: No package.json, tsconfig.json, or JS/TS source files found.\n`);
    writeOutput(`  Fix: Run Signalint from the root of a JavaScript or TypeScript repository.\n`);
  }

  // 3. Check engines
  writeOutput(`\nDiagnostics engines:\n`);
  const engines = await inspectEngines(projectRoot);
  for (const engine of engines) {
    if (engine.source === "not_installed") {
      writeOutput(`  - ${engine.name}: not installed\n`);
    } else {
      writeOutput(`  - ${engine.name}: ${engine.source} copy (${engine.version ?? "unknown version"})\n`);
    }
  }

  // 4. Check MCP clients
  writeOutput(`\nMCP client configurations:\n`);
  const staleCwdFindings: StaleCwdFinding[] = [];
  for (const spec of CLIENT_REGISTRY) {
    const configPath = spec.configPath(projectRoot, homeDirectory);
    if (!(await pathExists(configPath))) {
      continue;
    }

    const finding = await inspectClientConfig(spec, configPath, projectRoot);
    if (finding !== undefined) {
      staleCwdFindings.push(finding);
    }
  }

  if (staleCwdFindings.length > 0) {
    hasBlockingProblem = true;
    for (const finding of staleCwdFindings) {
      writeOutput(`[ERROR] Stale cwd in ${finding.client.label} (${finding.configPath}):\n`);
      writeOutput(`  Entry cwd:    ${finding.configuredCwd}\n`);
      writeOutput(`  Current root: ${finding.currentProjectRoot}\n`);
      writeOutput(`  Fix: Remove 'cwd' from ${finding.configPath} or update it to ${finding.currentProjectRoot}.\n`);
    }
  } else {
    writeOutput(`[OK] No stale cwd references found in active MCP configurations.\n`);
  }

  // 5. Legacy Antigravity check
  const legacyAntigravity = getLegacyAntigravityConfigPath(homeDirectory);
  if (await pathExists(legacyAntigravity)) {
    try {
      const parsed = JSON.parse(await readFile(legacyAntigravity, "utf8")) as unknown;
      if (isRecord(parsed) && isRecord(parsed.mcpServers) && "signalint" in parsed.mcpServers) {
        writeOutput(
          `\n[WARNING] Found legacy Signalint entry in ${legacyAntigravity}.\n` +
          `  Fix: Remove the "signalint" entry from ${legacyAntigravity} to prevent configuration shadowing.\n`,
        );
      }
    } catch {
      // Ignore parse error on legacy file
    }
  }

  writeOutput(`\nDoctor report: ${hasBlockingProblem ? "FAILED (action required)" : "PASSED"}\n`);
  return hasBlockingProblem ? 1 : 0;
}

async function inspectEngines(projectRoot: string): Promise<EngineInfo[]> {
  return [
    await inspectEngine("oxlint", "oxlint/package.json", projectRoot),
    await inspectEngine("tsc", "typescript/package.json", projectRoot),
    await inspectEngine("biome", "@biomejs/biome/package.json", projectRoot),
  ];
}

async function inspectEngine(
  name: string,
  packageSpecifier: string,
  projectRoot: string,
): Promise<EngineInfo> {
  const require = createRequire(import.meta.url);
  let resolvedPath: string | undefined;
  let source: "project" | "bundled" = "bundled";

  try {
    resolvedPath = require.resolve(packageSpecifier, { paths: [projectRoot] });
    const rel = relative(projectRoot, resolvedPath);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      source = "project";
    }
  } catch {
    try {
      resolvedPath = require.resolve(packageSpecifier);
      source = "bundled";
    } catch {
      return { name, source: "not_installed", version: undefined };
    }
  }

  let version: string | undefined;
  if (resolvedPath !== undefined) {
    try {
      const pkg = JSON.parse(await readFile(resolvedPath, "utf8")) as unknown;
      if (isRecord(pkg) && typeof pkg.version === "string") {
        version = `v${pkg.version}`;
      }
    } catch {
      version = undefined;
    }
  }

  return { name, source, version };
}

function canonicalizeConfiguredCwd(cwd: string): string {
  return canonicalizePath(cwd);
}

function isSamePath(a: string, b: string): boolean {
  if (process.platform === "win32" || process.platform === "darwin") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

async function inspectClientConfig(
  spec: McpClientSpec,
  configPath: string,
  projectRoot: string,
): Promise<StaleCwdFinding | undefined> {
  try {
    const content = await readFile(configPath, "utf8");
    if (spec.format === "toml") {
      const match = /\[mcp_servers\.signalint\][\s\S]*?(?:cwd\s*=\s*["']([^"']+)["'])/m.exec(content);
      if (match && match[1]) {
        const canonicalCwd = canonicalizeConfiguredCwd(match[1]);
        if (!isSamePath(canonicalCwd, projectRoot)) {
          return {
            client: spec,
            configPath,
            configuredCwd: match[1],
            currentProjectRoot: projectRoot,
          };
        }
      }
      return undefined;
    }

    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) {
      return undefined;
    }

    const serverContainer = spec.format === "servers" ? parsed.servers : parsed.mcpServers;
    if (!isRecord(serverContainer) || !isRecord(serverContainer.signalint)) {
      return undefined;
    }

    const signalintEntry = serverContainer.signalint;
    if (typeof signalintEntry.cwd === "string") {
      const canonicalCwd = canonicalizeConfiguredCwd(signalintEntry.cwd);
      if (!isSamePath(canonicalCwd, projectRoot)) {
        return {
          client: spec,
          configPath,
          configuredCwd: signalintEntry.cwd,
          currentProjectRoot: projectRoot,
        };
      }
    }
  } catch {
    // Ignore read/parse error during client inspection
  }
  return undefined;
}

async function hasJsProjectMarkers(projectRoot: string): Promise<boolean> {
  try {
    const rootEntries = await readdir(projectRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile()) {
        const name = entry.name.toLowerCase();
        if (name === "package.json" || name === "tsconfig.json") {
          return true;
        }
        if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i.test(name)) {
          return true;
        }
      }
    }

    let count = rootEntries.length;
    const queue: string[] = [];
    for (const entry of rootEntries) {
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        queue.push(resolve(projectRoot, entry.name));
      }
    }

    while (queue.length > 0 && count < 2000) {
      const currentDir = queue.shift();
      if (!currentDir) {
        break;
      }
      let subEntries;
      try {
        subEntries = await readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of subEntries) {
        count++;
        if (entry.isFile()) {
          if (/\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i.test(entry.name)) {
            return true;
          }
        } else if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
          queue.push(resolve(currentDir, entry.name));
        }
        if (count >= 2000) {
          break;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
