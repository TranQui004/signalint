import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  CLIENT_REGISTRY,
  getLegacyAntigravityConfigPath,
  type McpClientSpec,
} from "./clients/registry.js";
import {
  DEFAULT_CONFIG,
  FLAT_ESLINT_CONFIG_FILES,
  isEngineEnabled,
  loadSignalintConfig,
  type BiomeEngineConfig,
  type SignalintConfig,
} from "./config.js";
import { isRecord } from "./util/index.js";

export type McpClientName = string;

export interface ProjectToolDetection {
  biomeConfig: string | undefined;
  eslintConfig: string | undefined;
  oxlintConfigs: string[];
  prettierConfig: string | undefined;
  tsconfig: boolean;
}

export interface McpClientCandidate {
  client: McpClientName;
  configPath: string;
  spec: McpClientSpec;
}

export interface InitPrompts {
  chooseClient(candidates: readonly McpClientCandidate[]): Promise<McpClientCandidate | undefined>;
  confirmWrite(candidate: McpClientCandidate): Promise<boolean>;
  confirmGitignore?(path: string): Promise<boolean>;
}

export interface InitCommandOptions {
  cwd?: string | undefined;
  homeDir?: string | undefined;
  interactive?: boolean | undefined;
  platform?: NodeJS.Platform | undefined;
  prompts?: InitPrompts | undefined;
  writeOutput?: ((message: string) => void) | undefined;
}

interface McpServerEntry {
  args: string[];
  command: string;
  cwd?: string;
}

const PRETTIER_CONFIG_NAMES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
];

/** Detects root TypeScript, Oxlint, Biome, ESLint, and Prettier configuration files in a target project. */
export async function detectProjectTools(cwd: string): Promise<ProjectToolDetection> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const oxlintConfigs = fileNames
    .filter((name) => name === ".oxlintrc" || name.startsWith(".oxlintrc."))
    .sort();
  const biomeConfig = ["biome.json", "biome.jsonc"].find((name) => fileNames.includes(name));
  const eslintConfig = FLAT_ESLINT_CONFIG_FILES.find((name) => fileNames.includes(name));
  const prettierConfig = PRETTIER_CONFIG_NAMES.find((name) => fileNames.includes(name));

  return {
    biomeConfig,
    eslintConfig,
    oxlintConfigs,
    prettierConfig,
    tsconfig: fileNames.includes("tsconfig.json"),
  };
}

/** Creates a schema-valid config that follows detected project tooling and defaults to Oxlint. */
export function createDetectedConfig(detection: ProjectToolDetection): SignalintConfig {
  const hasBiome = detection.biomeConfig !== undefined;
  const hasEslint = detection.eslintConfig !== undefined;
  return {
    engines: {
      oxlint: detection.oxlintConfigs.length > 0 || !hasBiome,
      tsc: detection.tsconfig,
      biome: hasBiome,
      eslint: hasEslint,
    },
    ignore: [...DEFAULT_CONFIG.ignore],
    timeoutsMs: { ...DEFAULT_CONFIG.timeoutsMs },
  };
}

/** Detects available MCP client configurations, prioritizing project-scoped configurations. */
export async function detectMcpClients(
  cwd: string,
  homeDirectory: string = homedir(),
): Promise<McpClientCandidate[]> {
  const projectCandidates: McpClientCandidate[] = [];
  const userCandidates: McpClientCandidate[] = [];

  for (const spec of CLIENT_REGISTRY) {
    const configPath = spec.configPath(cwd, homeDirectory);
    const markerPath = spec.marker(cwd);
    const isDetected = (await exists(markerPath)) || (await exists(configPath));
    if (isDetected) {
      const candidate: McpClientCandidate = {
        client: spec.id,
        configPath,
        spec,
      };
      if (spec.scope === "project") {
        projectCandidates.push(candidate);
      } else {
        userCandidates.push(candidate);
      }
    }
  }

  return [...projectCandidates, ...userCandidates];
}

/** Returns default project-scoped client candidates when no clients are explicitly detected. */
export function getDefaultCandidates(cwd: string, homeDirectory: string): McpClientCandidate[] {
  return CLIENT_REGISTRY.filter((spec) => spec.scope === "project").map((spec) => ({
    client: spec.id,
    configPath: spec.configPath(cwd, homeDirectory),
    spec,
  }));
}

/** Writes detected project settings and requires confirmation before changing an MCP client config. */
export async function runInitCommand(options: InitCommandOptions = {}): Promise<number> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const homeDirectory = resolve(options.homeDir ?? homedir());
  const platform = options.platform ?? process.platform;
  const writeOutput = options.writeOutput ?? ((message: string) => process.stdout.write(message));

  const detection = await detectProjectTools(cwd);
  const detectedConfig = createDetectedConfig(detection);
  const configPath = resolve(cwd, "signalint.config.json");
  const configCreated = await writeConfigIfMissing(configPath, detectedConfig);
  const effectiveConfig = configCreated ? detectedConfig : await loadSignalintConfig(cwd);
  writeOutput(formatDetectionSummary(detection, effectiveConfig, configCreated));

  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  await ensureGitignore(cwd, options.prompts, interactive, writeOutput);

  // Migration warning for legacy Antigravity configuration
  const legacyAntigravity = getLegacyAntigravityConfigPath(homeDirectory);
  if (await exists(legacyAntigravity)) {
    try {
      const parsed = JSON.parse(await readFile(legacyAntigravity, "utf8")) as unknown;
      if (isRecord(parsed) && isRecord(parsed.mcpServers) && "signalint" in parsed.mcpServers) {
        writeOutput(
          `\n[WARNING] Found legacy Signalint entry in ${legacyAntigravity}.\n` +
          `  Fix: Remove the "signalint" entry from ${legacyAntigravity} to prevent configuration shadowing.\n\n`,
        );
      }
    } catch {
      // Ignore parse failure on legacy file
    }
  }

  const candidates = await detectMcpClients(cwd, homeDirectory);
  const defaultCandidates = getDefaultCandidates(cwd, homeDirectory);
  if (!interactive) {
    const printable = candidates.length === 0 ? defaultCandidates : candidates;
    writeOutput(formatCopyableSnippets(printable, cwd, platform));
    return 0;
  }

  if (options.prompts !== undefined) {
    await configureSelectedClient(
      candidates,
      defaultCandidates,
      cwd,
      platform,
      options.prompts,
      writeOutput,
    );
    return 0;
  }

  const terminal = createTerminalPrompts();
  try {
    await configureSelectedClient(
      candidates,
      defaultCandidates,
      cwd,
      platform,
      terminal.prompts,
      writeOutput,
    );
  } finally {
    terminal.close();
  }
  return 0;
}

/** Runs init with concise stderr failures instead of an uncaught stack dump. */
export async function runInitCommandSafely(options: InitCommandOptions = {}): Promise<number> {
  try {
    return await runInitCommand(options);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[signalint] init failed: ${message}\n`);
    return 1;
  }
}

async function configureSelectedClient(
  candidates: readonly McpClientCandidate[],
  defaultCandidates: readonly McpClientCandidate[],
  cwd: string,
  platform: NodeJS.Platform,
  prompts: InitPrompts,
  writeOutput: (message: string) => void,
): Promise<void> {
  if (candidates.length === 0) {
    writeOutput(formatCopyableSnippets(defaultCandidates, cwd, platform));
    return;
  }
  const candidate = candidates.length === 1 ? candidates[0] : await prompts.chooseClient(candidates);
  if (candidate === undefined || !(await prompts.confirmWrite(candidate))) {
    writeOutput(formatCopyableSnippets(candidates, cwd, platform));
    return;
  }

  const isInside = isInsideProjectRoot(candidate.configPath, cwd);
  const includeCwd = isInside && candidate.spec.supportsCwd;
  const entry = createMcpServerEntry(platform, includeCwd ? cwd : undefined);

  if (!isInside || candidate.spec.scope === "user") {
    writeOutput(
      `\n[WARNING] Target MCP configuration is global/user-scoped (${candidate.configPath}).\n` +
      `  Omitting 'cwd' so the server runs in whichever directory the client launches it.\n` +
      `  For project-isolated settings, prefer a project-scoped config:\n` +
      `    ${formatPerProjectAlternative(candidate.spec, cwd, platform)}\n\n`,
    );
  }

  await writeClientConfig(candidate, entry);
  writeOutput(`Updated ${candidate.spec.label} MCP config: ${candidate.configPath}\n`);

  if (candidate.spec.addCommand !== undefined) {
    writeOutput(`CLI alternative: ${candidate.spec.addCommand}\n`);
  }
}

function formatPerProjectAlternative(
  spec: McpClientSpec,
  cwd: string,
  platform: NodeJS.Platform,
): string {
  const projectSpec = CLIENT_REGISTRY.find((s) => s.id === spec.id && s.scope === "project");
  if (projectSpec) {
    const pPath = projectSpec.configPath(cwd, "");
    const entry = createMcpServerEntry(platform, projectSpec.supportsCwd ? cwd : undefined);
    return `${projectSpec.label} at ${pPath}:\n    ${JSON.stringify({ mcpServers: { signalint: entry } })}`;
  }
  return `Consider running within ${cwd} or setting SIGNALINT_PROJECT_ROOT=${cwd}`;
}

async function writeClientConfig(
  candidate: McpClientCandidate,
  entry: McpServerEntry,
): Promise<void> {
  const { format } = candidate.spec;
  if (format === "toml") {
    await mergeCodexTomlConfig(candidate.configPath, entry);
  } else if (format === "servers") {
    await mergeServersConfig(candidate.configPath, entry);
  } else if (format === "zed") {
    await mergeZedConfig(candidate.configPath, entry);
  } else {
    await mergeMcpServersConfig(candidate.configPath, entry);
  }
}

function createTerminalPrompts(): { close: () => void; prompts: InitPrompts } {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    close: () => readline.close(),
    prompts: {
      chooseClient: async (candidates) => {
        const choices = candidates
          .map((candidate, index) => `${index + 1}. ${candidate.spec.label} (${candidate.configPath})`)
          .join("\n");
        const answer = await readline.question(`Multiple MCP clients detected:\n${choices}\nChoose a client: `);
        const selectedIndex = Number.parseInt(answer, 10) - 1;
        return candidates[selectedIndex];
      },
      confirmWrite: async (candidate) => {
        const answer = await readline.question(
          `Write the Signalint entry to ${candidate.configPath}? [Y/n] `,
        );
        return answer.trim() === "" || /^(?:y|yes)$/i.test(answer.trim());
      },
      confirmGitignore: async (path: string) => {
        const answer = await readline.question(
          `Append .signalint/ to ${path}? [Y/n] `,
        );
        return answer.trim() === "" || /^(?:y|yes)$/i.test(answer.trim());
      },
    },
  };
}

async function writeConfigIfMissing(path: string, config: SignalintConfig): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error: unknown) {
    if (isFileExistsError(error)) {
      return false;
    }
    throw error;
  }
}

async function mergeMcpServersConfig(path: string, entry: McpServerEntry): Promise<void> {
  const document = await readJsonObjectIfPresent(path);
  const existingServers = document.mcpServers;
  if (existingServers !== undefined && !isRecord(existingServers)) {
    throw new Error(`${path} field "mcpServers" must be an object.`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      ...document,
      mcpServers: { ...existingServers, signalint: entry },
    }, null, 2)}\n`,
    "utf8",
  );
}

async function mergeServersConfig(path: string, entry: McpServerEntry): Promise<void> {
  const document = await readJsonObjectIfPresent(path);
  const existingServers = document.servers;
  if (existingServers !== undefined && !isRecord(existingServers)) {
    throw new Error(`${path} field "servers" must be an object.`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      ...document,
      servers: { ...existingServers, signalint: entry },
    }, null, 2)}\n`,
    "utf8",
  );
}

async function mergeZedConfig(path: string, entry: McpServerEntry): Promise<void> {
  const document = await readJsonObjectIfPresent(path);
  const existingServers = document.context_servers;
  if (existingServers !== undefined && !isRecord(existingServers)) {
    throw new Error(`${path} field "context_servers" must be an object.`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      ...document,
      context_servers: {
        ...existingServers,
        signalint: {
          command: {
            path: entry.command,
            args: entry.args,
          },
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

async function mergeCodexTomlConfig(path: string, entry: McpServerEntry): Promise<void> {
  let existingContent = "";
  try {
    existingContent = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const blockLines = [
    "[mcp_servers.signalint]",
    `command = ${JSON.stringify(entry.command)}`,
    `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
    "startup_timeout_sec = 20",
  ];
  if (entry.cwd !== undefined) {
    blockLines.push(`cwd = ${JSON.stringify(entry.cwd)}`);
  }
  const tomlBlock = blockLines.join("\n");

  let updatedContent: string;
  const sectionHeader = "[mcp_servers.signalint]";
  const sectionIndex = existingContent.indexOf(sectionHeader);
  if (sectionIndex !== -1) {
    const afterHeader = existingContent.slice(sectionIndex + sectionHeader.length);
    const nextSectionMatch = /\n\s*\[/m.exec(afterHeader);
    if (nextSectionMatch) {
      const nextIndex = sectionIndex + sectionHeader.length + nextSectionMatch.index;
      updatedContent = existingContent.slice(0, sectionIndex) + tomlBlock + "\n" + existingContent.slice(nextIndex + 1);
    } else {
      updatedContent = existingContent.slice(0, sectionIndex) + tomlBlock + "\n";
    }
  } else {
    updatedContent = existingContent.trim().length > 0
      ? `${existingContent.trimEnd()}\n\n${tomlBlock}\n`
      : `${tomlBlock}\n`;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, updatedContent, "utf8");
}

async function readJsonObjectIfPresent(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) {
      throw new Error(`${path} must contain a JSON object.`);
    }
    return parsed;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }
}

function createMcpServerEntry(platform: NodeJS.Platform, cwd?: string): McpServerEntry {
  const base = platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "--no-install", "signalint-mcp"] }
    : { command: "npx", args: ["--no-install", "signalint-mcp"] };
  return cwd !== undefined ? { ...base, cwd } : base;
}

function isInsideProjectRoot(configPath: string, projectRoot: string): boolean {
  const rel = relative(projectRoot, configPath);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function ensureGitignore(
  cwd: string,
  prompts: InitPrompts | undefined,
  interactive: boolean,
  writeOutput: (message: string) => void,
): Promise<void> {
  const gitignorePath = resolve(cwd, ".gitignore");
  let content = "";
  try {
    content = await readFile(gitignorePath, "utf8");
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(".signalint") || lines.includes(".signalint/")) {
    return;
  }

  let shouldAppend = true;
  if (interactive && prompts?.confirmGitignore !== undefined) {
    shouldAppend = await prompts.confirmGitignore(gitignorePath);
  }

  if (shouldAppend) {
    const trailingNewline = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    const updated = `${content}${trailingNewline}.signalint/\n`;
    await writeFile(gitignorePath, updated, "utf8");
    writeOutput(`Appended .signalint/ to ${gitignorePath}\n`);
  }
}

function formatDetectionSummary(
  detection: ProjectToolDetection,
  config: SignalintConfig,
  configCreated: boolean,
): string {
  const tools = [
    detection.tsconfig ? "tsconfig.json" : undefined,
    ...detection.oxlintConfigs,
    detection.biomeConfig,
    detection.eslintConfig,
    detection.prettierConfig,
  ].filter((value): value is string => value !== undefined);
  const action = configCreated ? "Created" : "Kept existing";
  return [
    `${action} signalint.config.json.`,
    `Detected project tooling: ${tools.length === 0 ? "none" : tools.join(", ")}.`,
    `Configured engines: oxlint=${formatEnabled(config.engines.oxlint)}, ` +
      `tsc=${formatEnabled(config.engines.tsc)}, biome=${formatEnabled(config.engines.biome)}, ` +
      `eslint=${formatEnabled(config.engines.eslint)}.`,
    "",
  ].join("\n");
}

function formatCopyableSnippets(
  candidates: readonly McpClientCandidate[],
  cwd: string,
  platform: NodeJS.Platform,
): string {
  const snippets = candidates.map((candidate) => {
    const isInside = isInsideProjectRoot(candidate.configPath, cwd);
    const includeCwd = isInside && candidate.spec.supportsCwd;
    const entry = createMcpServerEntry(platform, includeCwd ? cwd : undefined);
    let snippetBody: string;

    if (candidate.spec.format === "toml") {
      const lines = [
        "[mcp_servers.signalint]",
        `command = ${JSON.stringify(entry.command)}`,
        `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`,
        "startup_timeout_sec = 20",
      ];
      if (entry.cwd !== undefined) {
        lines.push(`cwd = ${JSON.stringify(entry.cwd)}`);
      }
      snippetBody = lines.join("\n");
      if (candidate.spec.addCommand !== undefined) {
        snippetBody += `\n\nOr run:\n  ${candidate.spec.addCommand}`;
      }
    } else if (candidate.spec.format === "servers") {
      snippetBody = JSON.stringify({ servers: { signalint: entry } }, null, 2);
    } else if (candidate.spec.format === "zed") {
      snippetBody = JSON.stringify(
        {
          context_servers: {
            signalint: {
              command: {
                path: entry.command,
                args: entry.args,
              },
            },
          },
        },
        null,
        2,
      );
    } else {
      snippetBody = JSON.stringify({ mcpServers: { signalint: entry } }, null, 2);
    }

    return `${candidate.spec.label} (${candidate.configPath}):\n${snippetBody}`;
  });

  return `MCP client configuration was not written. Copy the appropriate snippet:\n\n${snippets.join("\n\n")}\n`;
}

function formatEnabled(enabled: boolean | BiomeEngineConfig): string {
  return isEngineEnabled(enabled) ? "on" : "off";
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
