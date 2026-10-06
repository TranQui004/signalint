import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CLIENT_REGISTRY, type McpClientSpec } from "../src/clients/registry.js";
import { runInitCommand, type McpClientCandidate } from "../src/init.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("MCP Client Registry & Init", () => {
  it("returns verified table config paths on both posix and win32 separators", () => {
    const posixRoot = "/work/project";
    const posixHome = "/home/user";

    const winRoot = "C:\\work\\project";
    const winHome = "C:\\Users\\user";

    const expectedPosix: Record<string, string> = {
      "claude:project": "/work/project/.mcp.json",
      "claude:user": "/home/user/.claude.json",
      "cursor:project": "/work/project/.cursor/mcp.json",
      "cursor:user": "/home/user/.cursor/mcp.json",
      "codex:project": "/work/project/.codex/config.toml",
      "codex:user": "/home/user/.codex/config.toml",
      "antigravity:project": "/work/project/.agents/mcp_config.json",
      "antigravity:user": "/home/user/.gemini/config/mcp_config.json",
      "vscode:project": "/work/project/.vscode/mcp.json",
      "windsurf:user": "/home/user/.codeium/windsurf/mcp_config.json",
      "zed:user": "/home/user/.config/zed/settings.json",
    };

    const expectedWin: Record<string, string> = {
      "claude:project": "C:\\work\\project\\.mcp.json",
      "claude:user": "C:\\Users\\user\\.claude.json",
      "cursor:project": "C:\\work\\project\\.cursor\\mcp.json",
      "cursor:user": "C:\\Users\\user\\.cursor\\mcp.json",
      "codex:project": "C:\\work\\project\\.codex\\config.toml",
      "codex:user": "C:\\Users\\user\\.codex\\config.toml",
      "antigravity:project": "C:\\work\\project\\.agents\\mcp_config.json",
      "antigravity:user": "C:\\Users\\user\\.gemini\\config\\mcp_config.json",
      "vscode:project": "C:\\work\\project\\.vscode\\mcp.json",
      "windsurf:user": "C:\\Users\\user\\.codeium\\windsurf\\mcp_config.json",
      "zed:user": "C:\\Users\\user\\.config\\zed\\settings.json",
    };

    for (const spec of CLIENT_REGISTRY) {
      const key = `${spec.id}:${spec.scope}`;
      expect(spec.configPath(posixRoot, posixHome)).toBe(expectedPosix[key]);
      expect(spec.configPath(winRoot, winHome)).toBe(expectedWin[key]);
    }
  });

  it("verifies Antigravity project and user candidate paths", () => {
    const projectSpec = CLIENT_REGISTRY.find(
      (spec) => spec.id === "antigravity" && spec.scope === "project",
    ) as McpClientSpec;
    const userSpec = CLIENT_REGISTRY.find(
      (spec) => spec.id === "antigravity" && spec.scope === "user",
    ) as McpClientSpec;

    expect(projectSpec.configPath("/root", "/home")).toBe("/root/.agents/mcp_config.json");
    expect(userSpec.configPath("/root", "/home")).toBe("/home/.gemini/config/mcp_config.json");
  });

  it("writes cwd when configuring a project-scoped path", async () => {
    const root = await createTemporaryProject();
    const cursorDir = join(root, ".cursor");
    await mkdir(cursorDir, { recursive: true });
    await writeFile(join(cursorDir, "mcp.json"), "{}\n", "utf8");

    const chooseClient = vi.fn(async (candidates: readonly McpClientCandidate[]) =>
      candidates.find((c) => c.client === "cursor" && c.spec.scope === "project"),
    );

    await runInitCommand({
      cwd: root,
      homeDir: join(root, "home"),
      interactive: true,
      platform: "linux",
      prompts: {
        chooseClient,
        confirmWrite: async () => true,
      },
      writeOutput: () => undefined,
    });

    const content = JSON.parse(await readFile(join(cursorDir, "mcp.json"), "utf8")) as Record<string, unknown>;
    const mcpServers = content.mcpServers as Record<string, unknown>;
    const signalint = mcpServers.signalint as Record<string, unknown>;
    expect(signalint.cwd).toBe(root);
  });

  it("omits cwd and emits a warning when configuring a user-scoped path", async () => {
    const root = await createTemporaryProject();
    const homeDir = await createTemporaryProject();
    const cursorUserDir = join(homeDir, ".cursor");
    await mkdir(cursorUserDir, { recursive: true });
    const userConfigPath = join(cursorUserDir, "mcp.json");
    await writeFile(userConfigPath, "{}\n", "utf8");

    const output: string[] = [];
    const chooseClient = vi.fn(async (candidates: readonly McpClientCandidate[]) =>
      candidates.find((c) => c.client === "cursor" && c.spec.scope === "user"),
    );

    await runInitCommand({
      cwd: root,
      homeDir,
      interactive: true,
      platform: "linux",
      prompts: {
        chooseClient,
        confirmWrite: async () => true,
      },
      writeOutput: (message) => output.push(message),
    });

    const content = JSON.parse(await readFile(userConfigPath, "utf8")) as Record<string, unknown>;
    const mcpServers = content.mcpServers as Record<string, unknown>;
    const signalint = mcpServers.signalint as Record<string, unknown>;
    expect(signalint.cwd).toBeUndefined();
    expect(output.join("")).toMatch(/WARNING.*global\/user-scoped/i);
  });

  it("emits valid TOML block for Codex CLI parseable into [mcp_servers.signalint]", async () => {
    const root = await createTemporaryProject();
    const codexDir = join(root, ".codex");
    await mkdir(codexDir, { recursive: true });
    const configPath = join(codexDir, "config.toml");
    await writeFile(configPath, "# Existing comments\n", "utf8");

    const chooseClient = vi.fn(async (candidates: readonly McpClientCandidate[]) =>
      candidates.find((c) => c.client === "codex" && c.spec.scope === "project"),
    );

    await runInitCommand({
      cwd: root,
      homeDir: join(root, "home"),
      interactive: true,
      platform: "linux",
      prompts: {
        chooseClient,
        confirmWrite: async () => true,
      },
      writeOutput: () => undefined,
    });

    const tomlContent = await readFile(configPath, "utf8");
    expect(tomlContent).toContain("[mcp_servers.signalint]");
    expect(tomlContent).toContain('command = "npx"');
    expect(tomlContent).toContain('args = ["--no-install", "signalint-mcp"]');
    expect(tomlContent).toContain("startup_timeout_sec = 20");
    expect(tomlContent).toContain(`cwd = ${JSON.stringify(root)}`);
  });
});

async function createTemporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "signalint-clients-"));
  temporaryRoots.push(root);
  return root;
}
