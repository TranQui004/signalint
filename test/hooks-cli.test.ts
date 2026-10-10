import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli.js";
import { previewHookInstall } from "../src/hooks/install.js";

const projectRoot = resolve(".");

describe("signalint hooks preview CLI", () => {
  it("outputs valid JSON preview for all supported runtimes", async () => {
    for (const runtime of ["claude", "cursor", "codex", "vscode"] as const) {
      let output = "";
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation((str) => {
        output += String(str);
        return true;
      });

      const exitCode = await runCli(["hooks", "preview", "--runtime", runtime], projectRoot);
      stdout.mockRestore();

      expect(exitCode).toBe(0);
      expect(() => JSON.parse(output)).not.toThrow();

      const parsed = JSON.parse(output) as Record<string, unknown>;
      expect(parsed).toHaveProperty("hooks");
    }
  });

  it("rejects unknown runtime on preview with exit code 2", async () => {
    let errOutput = "";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((str) => {
      errOutput += String(str);
      return true;
    });

    const exitCode = await runCli(["hooks", "preview", "--runtime", "unknown-runtime"], projectRoot);
    stderr.mockRestore();

    expect(exitCode).toBe(2);
    expect(errOutput).toContain("Usage: signalint hooks preview");
  });
});

describe("signalint hooks install CLI", () => {
  it("installs fresh config and merges non-destructively for Claude Code", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "signalint-cli-test-"));
    try {
      // 1. Fresh install
      const exitCode1 = await runCli(
        ["hooks", "install", "--runtime", "claude", "--confirm"],
        tempDir,
      );
      expect(exitCode1).toBe(0);

      const configPath = join(tempDir, ".claude", "config.json");
      const content1 = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      const hooks1 = content1["hooks"] as Record<string, unknown[]>;
      expect(hooks1["PostToolUse"]).toHaveLength(1);
      expect(hooks1["Stop"]).toHaveLength(1);

      // 2. Add custom user fields
      content1["userCustomSetting"] = "preserve-this-value";
      content1["mcpServers"] = { customServer: { command: "node server.js" } };
      hooks1["PostToolUse"]!.push({ matcher: "Custom", command: "echo custom" });
      await writeFile(configPath, JSON.stringify(content1, null, 2), "utf8");

      // 3. Re-run install to verify non-destructive merge
      const exitCode2 = await runCli(
        ["hooks", "install", "--runtime", "claude", "--confirm"],
        tempDir,
      );
      expect(exitCode2).toBe(0);

      const content2 = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      expect(content2["userCustomSetting"]).toBe("preserve-this-value");
      expect(content2["mcpServers"]).toEqual({ customServer: { command: "node server.js" } });

      const hooks2 = content2["hooks"] as Record<string, unknown[]>;
      // Should not duplicate signalint hook, while keeping the user's custom hook
      expect(hooks2["PostToolUse"]).toHaveLength(2);
      expect(hooks2["Stop"]).toHaveLength(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("merges non-destructively for Cursor configuration", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "signalint-cli-cursor-"));
    try {
      const cursorDir = join(tempDir, ".cursor");
      await mkdir(cursorDir, { recursive: true });
      const configPath = join(cursorDir, "hooks.json");
      const existing = {
        version: 1,
        userSetting: true,
        hooks: {
          beforeFileEdit: { command: "echo before" },
        },
      };
      await writeFile(configPath, JSON.stringify(existing, null, 2), "utf8");

      await runCli(["hooks", "install", "--runtime", "cursor", "--confirm"], tempDir);

      const preview = await previewHookInstall("cursor", tempDir);
      expect(preview.exists).toBe(true);
      expect(preview.merged).toBe(true);

      const content = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      expect(content["userSetting"]).toBe(true);
      const hooks = content["hooks"] as Record<string, unknown>;
      expect(hooks).toHaveProperty("beforeFileEdit");
      expect(hooks).toHaveProperty("afterFileEdit");
      expect(hooks).toHaveProperty("stop");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("signalint hooks run CLI", () => {
  it("runs adapter with --payload flag and outputs valid JSON decision", async () => {
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((str) => {
      output += String(str);
      return true;
    });

    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_input: { file_path: "src/index.ts" },
    });

    const exitCode = await runCli(
      ["hooks", "run", "--runtime", "claude", "--payload", payload],
      projectRoot,
    );
    stdout.mockRestore();

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).toHaveProperty("decision");
  });

  it("prints hooks usage for --help or bare 'hooks'", async () => {
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((str) => {
      output += String(str);
      return true;
    });

    const exitCode = await runCli(["hooks"], projectRoot);
    stdout.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain("Usage: signalint hooks <run|install|preview>");
  });

  it("returns error code 2 on unknown hooks subcommand", async () => {
    let errOutput = "";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((str) => {
      errOutput += String(str);
      return true;
    });

    const exitCode = await runCli(["hooks", "unknownSubcommand"], projectRoot);
    stderr.mockRestore();

    expect(exitCode).toBe(2);
    expect(errOutput).toContain("Unknown hooks subcommand: unknownSubcommand");
  });
});
