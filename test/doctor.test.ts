import { symlinkSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { runDoctorCommand } from "../src/doctor.js";
import { canonicalizePath } from "../src/projectPaths.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("signalint doctor", () => {
  it("passes on a properly initialized project without stale configs", async () => {
    const root = await createTemporaryProject();
    const homeDir = await createTemporaryProject();
    await writeFile(join(root, "signalint.config.json"), "{}\n", "utf8");
    await writeFile(join(root, "package.json"), '{"name":"test"}\n', "utf8");

    const output: string[] = [];
    const code = await runDoctorCommand({
      cwd: root,
      homeDir,
      writeOutput: (msg) => output.push(msg),
    });

    expect(code).toBe(0);
    const combined = output.join("");
    expect(combined).toContain("signalint.config.json found");
    expect(combined).toContain("JavaScript/TypeScript project detected");
    expect(combined).toContain("PASSED");
  });

  it("fails when signalint.config.json is missing", async () => {
    const root = await createTemporaryProject();
    const homeDir = await createTemporaryProject();
    await writeFile(join(root, "package.json"), '{"name":"test"}\n', "utf8");

    const output: string[] = [];
    const code = await runDoctorCommand({
      cwd: root,
      homeDir,
      writeOutput: (msg) => output.push(msg),
    });

    expect(code).toBe(1);
    const combined = output.join("");
    expect(combined).toContain("signalint.config.json is missing");
    expect(combined).toContain("Run 'npx signalint-mcp init'");
    expect(combined).toContain("FAILED (action required)");
  });

  it("fails when an active MCP config contains a stale cwd from another project", async () => {
    const root = await createTemporaryProject();
    const homeDir = await createTemporaryProject();
    await writeFile(join(root, "signalint.config.json"), "{}\n", "utf8");
    await writeFile(join(root, "package.json"), '{"name":"test"}\n', "utf8");

    const staleProjectPath = join(homeDir, "other-project");
    const claudeUserConfig = join(homeDir, ".claude.json");
    await writeFile(
      claudeUserConfig,
      JSON.stringify(
        {
          mcpServers: {
            signalint: {
              command: "npx",
              args: ["--no-install", "signalint-mcp"],
              cwd: staleProjectPath,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const output: string[] = [];
    const code = await runDoctorCommand({
      cwd: root,
      homeDir,
      writeOutput: (msg) => output.push(msg),
    });

    expect(code).toBe(1);
    const combined = output.join("");
    expect(combined).toContain("Stale cwd in Claude Code (user)");
    expect(combined).toContain(staleProjectPath);
    expect(combined).toContain(root);
    expect(combined).toContain("FAILED (action required)");
  });

  it("fails when an active TOML or VS Code config contains a stale cwd", async () => {
    const root = await createTemporaryProject();
    const homeDir = await createTemporaryProject();
    await writeFile(join(root, "signalint.config.json"), "{}\n", "utf8");
    await writeFile(join(root, "package.json"), '{"name":"test"}\n', "utf8");

    const codexDir = join(homeDir, ".codex");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "config.toml"),
      '[mcp_servers.signalint]\ncommand = "npx"\nargs = ["--no-install", "signalint-mcp"]\ncwd = "/different/path"\n',
      "utf8",
    );

    const output: string[] = [];
    const code = await runDoctorCommand({
      cwd: root,
      homeDir,
      writeOutput: (msg) => output.push(msg),
    });

    expect(code).toBe(1);
    const combined = output.join("");
    expect(combined).toContain("Stale cwd in Codex CLI (user)");
    expect(combined).toContain("/different/path");
  });

  it("warns when a legacy Antigravity configuration contains signalint", async () => {
    const root = await createTemporaryProject();
    const homeDir = await createTemporaryProject();
    await writeFile(join(root, "signalint.config.json"), "{}\n", "utf8");
    await writeFile(join(root, "package.json"), '{"name":"test"}\n', "utf8");

    const legacyDir = join(homeDir, ".gemini", "antigravity");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      join(legacyDir, "mcp_config.json"),
      '{"mcpServers":{"signalint":{"command":"npx"}}}\n',
      "utf8",
    );

    const output: string[] = [];
    const code = await runDoctorCommand({
      cwd: root,
      homeDir,
      writeOutput: (msg) => output.push(msg),
    });

    expect(code).toBe(0); // Warning only, not blocking
    const combined = output.join("");
    expect(combined).toContain("Found legacy Signalint entry");
    expect(combined).toContain("mcp_config.json");
  });

  it("fails when the directory is not a JS project", async () => {
    const root = await createTemporaryProject();
    const homeDir = await createTemporaryProject();
    await writeFile(join(root, "signalint.config.json"), "{}\n", "utf8");

    const output: string[] = [];
    const code = await runDoctorCommand({
      cwd: root,
      homeDir,
      writeOutput: (msg) => output.push(msg),
    });

    expect(code).toBe(1);
    const combined = output.join("");
    expect(combined).toContain("No package.json, tsconfig.json, or JS/TS source files found");
  });

  it("fails when the project root cannot be resolved", async () => {
    const output: string[] = [];
    const code = await runDoctorCommand({
      cwd: "/nonexistent-path-for-doctor-test-12345",
      writeOutput: (msg) => output.push(msg),
    });

    expect(code).toBe(1);
    const combined = output.join("");
    expect(combined).toContain("Could not resolve project root");
  });

  it("passes when an active MCP config uses a symlinked cwd pointing to the current project", async () => {
    const root = await createTemporaryProject();
    const homeDir = await createTemporaryProject();
    await writeFile(join(root, "signalint.config.json"), "{}\n", "utf8");
    await writeFile(join(root, "package.json"), '{"name":"test"}\n', "utf8");

    const symlinkRoot = join(
      tmpdir(),
      `signalint-doctor-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    symlinkSync(root, symlinkRoot, process.platform === "win32" ? "junction" : "dir");
    temporaryRoots.push(symlinkRoot);

    const claudeUserConfig = join(homeDir, ".claude.json");
    await writeFile(
      claudeUserConfig,
      JSON.stringify(
        {
          mcpServers: {
            signalint: {
              command: "npx",
              args: ["--no-install", "signalint-mcp"],
              cwd: symlinkRoot,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const output: string[] = [];
    const code = await runDoctorCommand({
      cwd: root,
      homeDir,
      writeOutput: (msg) => output.push(msg),
    });

    expect(code).toBe(0);
    const combined = output.join("");
    expect(combined).not.toContain("Stale cwd");
    expect(combined).toContain("PASSED");
  });

  it("can be invoked through runCli", async () => {
    const root = await createTemporaryProject();
    const homeDir = await createTemporaryProject();
    await writeFile(join(root, "signalint.config.json"), "{}\n", "utf8");
    await writeFile(join(root, "package.json"), '{"name":"test"}\n', "utf8");

    const code = await runCli(["doctor"], root, homeDir);
    expect(code).toBe(0);
  });
});

async function createTemporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "signalint-doctor-"));
  temporaryRoots.push(root);
  return canonicalizePath(root);
}
