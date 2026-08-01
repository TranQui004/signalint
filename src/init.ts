import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  DEFAULT_CONFIG,
  loadSignalintConfig,
  type SignalintConfig,
} from "./config.js";

export type McpClientName = "claude" | "cursor" | "antigravity";

export interface ProjectToolDetection {
  biomeConfig: string | undefined;
  oxlintConfigs: string[];
  tsconfig: boolean;
}

export interface McpClientCandidate {
  client: McpClientName;
  configPath: string;
}

export interface InitPrompts {
  chooseClient(candidates: readonly McpClientCandidate[]): Promise<McpClientCandidate | undefined>;
  confirmWrite(candidate: McpClientCandidate): Promise<boolean>;
}

export interface InitCommandOptions {
  cwd?: string;
  homeDir?: string;
  interactive?: boolean;
  platform?: NodeJS.Platform;
  prompts?: InitPrompts;
  writeOutput?: (message: string) => void;
}

interface McpServerEntry {
  args: string[];
  command: string;
  cwd: string;
}

const CLIENT_LABELS: Readonly<Record<McpClientName, string>> = {
  claude: "Claude Code",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

/** Detects root TypeScript, Oxlint, and Biome configuration files in a target project. */
export async function detectProjectTools(cwd: string): Promise<ProjectToolDetection> {
  const entries = await readdir(cwd, { withFileTypes: true });
  const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const oxlintConfigs = fileNames
    .filter((name) => name === ".oxlintrc" || name.startsWith(".oxlintrc."))
    .sort();
  const biomeConfig = ["biome.json", "biome.jsonc"].find((name) => fileNames.includes(name));
  return {
    biomeConfig,
    oxlintConfigs,
    tsconfig: fileNames.includes("tsconfig.json"),
  };
}

/** Creates a schema-valid config that follows detected project tooling and defaults to Oxlint. */
export function createDetectedConfig(detection: ProjectToolDetection): SignalintConfig {
  const hasBiome = detection.biomeConfig !== undefined;
  return {
    engines: {
      oxlint: detection.oxlintConfigs.length > 0 || !hasBiome,
      tsc: detection.tsconfig,
      biome: hasBiome,
    },
    ignore: [...DEFAULT_CONFIG.ignore],
    timeoutsMs: { ...DEFAULT_CONFIG.timeoutsMs },
  };
}

/** Detects project-local Claude/Cursor configs and the standard Antigravity config location. */
export async function detectMcpClients(
  cwd: string,
  homeDirectory: string = homedir(),
): Promise<McpClientCandidate[]> {
  const defaults = createDefaultCandidates(cwd, homeDirectory);
  const detected = await Promise.all(
    defaults.map(async (candidate) => ({
      candidate,
      present: await clientMarkerExists(candidate, cwd),
    })),
  );
  return detected.filter((item) => item.present).map((item) => item.candidate);
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

  const candidates = await detectMcpClients(cwd, homeDirectory);
  const defaultCandidates = createDefaultCandidates(cwd, homeDirectory);
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
  await mergeMcpServerConfig(candidate.configPath, createMcpServerEntry(cwd, platform));
  writeOutput(`Updated ${CLIENT_LABELS[candidate.client]} MCP config: ${candidate.configPath}\n`);
}

function createTerminalPrompts(): { close: () => void; prompts: InitPrompts } {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    close: () => readline.close(),
    prompts: {
      chooseClient: async (candidates) => {
        const choices = candidates
          .map((candidate, index) => `${index + 1}. ${CLIENT_LABELS[candidate.client]} (${candidate.configPath})`)
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

async function mergeMcpServerConfig(path: string, entry: McpServerEntry): Promise<void> {
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

function createMcpServerEntry(cwd: string, platform: NodeJS.Platform): McpServerEntry {
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "--no-install", "signalint-mcp"], cwd }
    : { command: "npx", args: ["--no-install", "signalint-mcp"], cwd };
}

function createDefaultCandidates(cwd: string, homeDirectory: string): McpClientCandidate[] {
  return [
    { client: "claude", configPath: resolve(cwd, ".mcp.json") },
    { client: "cursor", configPath: resolve(cwd, ".cursor", "mcp.json") },
    {
      client: "antigravity",
      configPath: resolve(homeDirectory, ".gemini", "antigravity", "mcp_config.json"),
    },
  ];
}

async function clientMarkerExists(candidate: McpClientCandidate, cwd: string): Promise<boolean> {
  if (candidate.client === "cursor") {
    return await exists(resolve(cwd, ".cursor"));
  }
  if (candidate.client === "antigravity") {
    return await exists(dirname(candidate.configPath));
  }
  return await exists(candidate.configPath);
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

function formatDetectionSummary(
  detection: ProjectToolDetection,
  config: SignalintConfig,
  configCreated: boolean,
): string {
  const tools = [
    detection.tsconfig ? "tsconfig.json" : undefined,
    ...detection.oxlintConfigs,
    detection.biomeConfig,
  ].filter((value): value is string => value !== undefined);
  const action = configCreated ? "Created" : "Kept existing";
  return [
    `${action} signalint.config.json.`,
    `Detected project tooling: ${tools.length === 0 ? "none" : tools.join(", ")}.`,
    `Configured engines: oxlint=${formatEnabled(config.engines.oxlint)}, ` +
      `tsc=${formatEnabled(config.engines.tsc)}, biome=${formatEnabled(config.engines.biome)}.`,
    "",
  ].join("\n");
}

function formatCopyableSnippets(
  candidates: readonly McpClientCandidate[],
  cwd: string,
  platform: NodeJS.Platform,
): string {
  const entry = createMcpServerEntry(cwd, platform);
  const snippets = candidates.map((candidate) => [
    `${CLIENT_LABELS[candidate.client]} (${candidate.configPath}):`,
    JSON.stringify({ mcpServers: { signalint: entry } }, null, 2),
  ].join("\n"));
  return `MCP client configuration was not written. Copy the appropriate snippet:\n\n${snippets.join("\n\n")}\n`;
}

function formatEnabled(enabled: boolean): string {
  return enabled ? "on" : "off";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
