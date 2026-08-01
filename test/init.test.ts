import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runInitCommand,
  type McpClientCandidate,
} from "../src/init.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("signalint init", () => {
  it("generates engine settings from detected TypeScript and Biome configuration", async () => {
    const root = await createTemporaryProject();
    await writeFile(join(root, "tsconfig.json"), "{}\n", "utf8");
    await writeFile(join(root, "biome.json"), "{}\n", "utf8");
    const output: string[] = [];

    await expect(runInitCommand({
      cwd: root,
      homeDir: root,
      interactive: false,
      platform: "linux",
      writeOutput: (message) => output.push(message),
    })).resolves.toBe(0);

    expect(await readJson(join(root, "signalint.config.json"))).toEqual({
      engines: { oxlint: false, tsc: true, biome: true },
      ignore: ["node_modules/**", "dist/**", ".signalint/**"],
      timeoutsMs: { oxlint: 30_000, tsc: 120_000, biome: 30_000 },
    });
    expect(output.join("")).toContain("Detected project tooling: tsconfig.json, biome.json.");
    expect(output.join("")).toContain("Claude Code");
    expect(output.join("")).toContain("Cursor");
    expect(output.join("")).toContain("Antigravity");
    await expect(readFile(join(root, ".mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects an Oxlint config without enabling unavailable project engines", async () => {
    const root = await createTemporaryProject();
    await writeFile(join(root, ".oxlintrc.jsonc"), "{}\n", "utf8");

    await runInitCommand({
      cwd: root,
      homeDir: root,
      interactive: false,
      platform: "linux",
      writeOutput: () => undefined,
    });

    const config = await readJson(join(root, "signalint.config.json"));
    expect(config.engines).toEqual({ oxlint: true, tsc: false, biome: false });
  });

  it("asks which client when multiple configs are present and preserves other servers", async () => {
    const root = await createTemporaryProject();
    await writeFile(join(root, ".mcp.json"), '{"mcpServers":{"claudeOther":{}}}\n', "utf8");
    await mkdir(join(root, ".cursor"));
    await writeFile(
      join(root, ".cursor", "mcp.json"),
      '{"mcpServers":{"other":{"command":"other"}}}\n',
      "utf8",
    );
    const chooseClient = vi.fn(async (candidates: readonly McpClientCandidate[]) =>
      candidates.find((candidate) => candidate.client === "cursor"));
    const confirmWrite = vi.fn(async () => true);

    await runInitCommand({
      cwd: root,
      homeDir: root,
      interactive: true,
      platform: "linux",
      prompts: { chooseClient, confirmWrite },
      writeOutput: () => undefined,
    });

    expect(chooseClient).toHaveBeenCalledOnce();
    expect(confirmWrite).toHaveBeenCalledOnce();
    expect(await readJson(join(root, ".cursor", "mcp.json"))).toEqual({
      mcpServers: {
        other: { command: "other" },
        signalint: {
          command: "npx",
          args: ["--no-install", "signalint-mcp"],
          cwd: root,
        },
      },
    });
    expect(await readJson(join(root, ".mcp.json"))).toEqual({
      mcpServers: { claudeOther: {} },
    });
  });

  it("writes the Windows-safe npx entry after confirming one detected client", async () => {
    const root = await createTemporaryProject();
    await writeFile(join(root, ".mcp.json"), "{}\n", "utf8");
    const chooseClient = vi.fn();

    await runInitCommand({
      cwd: root,
      homeDir: root,
      interactive: true,
      platform: "win32",
      prompts: {
        chooseClient,
        confirmWrite: async () => true,
      },
      writeOutput: () => undefined,
    });

    expect(chooseClient).not.toHaveBeenCalled();
    expect(await readJson(join(root, ".mcp.json"))).toEqual({
      mcpServers: {
        signalint: {
          command: "cmd",
          args: ["/c", "npx", "--no-install", "signalint-mcp"],
          cwd: root,
        },
      },
    });
  });

  it("detects and merges the standard Antigravity user configuration", async () => {
    const root = await createTemporaryProject();
    const homeDirectory = join(root, "home");
    const antigravityDirectory = join(homeDirectory, ".gemini", "antigravity");
    const configPath = join(antigravityDirectory, "mcp_config.json");
    await mkdir(antigravityDirectory, { recursive: true });
    await writeFile(configPath, '{"mcpServers":{"other":{"command":"other"}}}\n', "utf8");

    await runInitCommand({
      cwd: root,
      homeDir: homeDirectory,
      interactive: true,
      platform: "linux",
      prompts: {
        chooseClient: async () => undefined,
        confirmWrite: async () => true,
      },
      writeOutput: () => undefined,
    });

    expect(await readJson(configPath)).toEqual({
      mcpServers: {
        other: { command: "other" },
        signalint: {
          command: "npx",
          args: ["--no-install", "signalint-mcp"],
          cwd: root,
        },
      },
    });
  });

  it("dispatches init through the compiled signalint-mcp entrypoint", async () => {
    const root = await createTemporaryProject();
    await writeFile(join(root, "tsconfig.json"), "{}\n", "utf8");
    const entrypoint = resolve("dist", "src", "index.js");

    const result = await execFileAsync(process.execPath, [entrypoint, "init"], {
      cwd: root,
      timeout: 5_000,
      windowsHide: true,
    });

    expect(result.stdout).toContain("Created signalint.config.json.");
    expect(result.stdout).toContain("MCP client configuration was not written.");
    const config = await readJson(join(root, "signalint.config.json"));
    expect(config.engines).toEqual({ oxlint: true, tsc: true, biome: false });
  });
});

async function createTemporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "signalint-init-"));
  temporaryRoots.push(root);
  return root;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}
