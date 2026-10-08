import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CLI_VERBS, runEntrypoint } from "../src/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("signalint-mcp entrypoint dispatch", () => {
  it("exits promptly and prints doctor report when spawned with 'doctor' while holding stdin open", async () => {
    const entrypoint = resolve("dist/src/index.js");
    const child = spawn(process.execPath, [entrypoint, "doctor"], {
      cwd: resolve("test/fixtures/fresh-install-project"),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    const exitPromise = new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill();
        rejectExit(new Error("Timeout: doctor child process hung instead of running CLI doctor"));
      }, 10_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });

    const code = await exitPromise;
    expect(code).toBe(0);
    expect(stdout).toContain("=== Signalint Doctor ===");
    expect(stdout).toContain("Doctor report:");
  });

  it("exits promptly and prints check JSON when spawned with 'check', '.' while holding stdin open", async () => {
    const entrypoint = resolve("dist/src/index.js");
    const child = spawn(process.execPath, [entrypoint, "check", "."], {
      cwd: resolve("test/fixtures/fresh-install-project"),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    const exitPromise = new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill();
        rejectExit(new Error("Timeout: check child process hung instead of running CLI check"));
      }, 10_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });

    const code = await exitPromise;
    expect([0, 1]).toContain(code);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe("1.4");
    expect(typeof parsed.status).toBe("string");
  });

  it("dispatches init through the compiled signalint-mcp entrypoint and creates config", async () => {
    const root = await mkdtemp(join(tmpdir(), "signalint-index-init-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "tsconfig.json"), "{}\n", "utf8");
    const entrypoint = resolve("dist/src/index.js");

    const child = spawn(process.execPath, [entrypoint, "init"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    const exitPromise = new Promise<number | null>((resolveExit, rejectExit) => {
      const timer = setTimeout(() => {
        child.kill();
        rejectExit(new Error("Timeout: init hung"));
      }, 10_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolveExit(code);
      });
    });

    const exitCode = await exitPromise;
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created signalint.config.json.");
    const config = JSON.parse(await readFile(join(root, "signalint.config.json"), "utf8")) as Record<string, unknown>;
    expect(config.engines).toBeDefined();
  });

  it("starts the MCP server when invoked with no verb and non-TTY stdin", async () => {
    const entrypoint = resolve("dist/src/index.js");
    const child = spawn(process.execPath, [entrypoint], {
      cwd: resolve("test/fixtures/fresh-install-project"),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    const startedPromise = new Promise<void>((resolveStarted, rejectStarted) => {
      const timer = setTimeout(() => {
        child.kill();
        rejectStarted(new Error(`Timeout: server did not start. Stderr: ${stderr}`));
      }, 10_000);

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.includes("[signalint] project root:")) {
          clearTimeout(timer);
          resolveStarted();
        }
      });
    });

    await startedPromise;
    expect(stderr).toContain("[signalint] project root:");

    child.kill();
  });

  // In CI, process.stdin.isTTY is false because test runners execute in non-interactive pipes.
  // We unit-test the isTTY guidance branch directly by passing isTty = true.
  it("writes guidance to stderr and returns exit code 2 when run with no verb on a TTY", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runEntrypoint([], true);
    expect(code).toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("signalint-mcp is the MCP server entry point: it speaks JSON-RPC over stdio"),
    );
  });

  it("writes guidance to stderr and returns exit code 2 when run with an unrecognized verb on a TTY", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runEntrypoint(["not-a-command"], true);
    expect(code).toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("signalint-mcp is the MCP server entry point: it speaks JSON-RPC over stdio"),
    );
  });

  it("recognizes all documented CLI verbs", () => {
    expect(CLI_VERBS.has("init")).toBe(true);
    expect(CLI_VERBS.has("check")).toBe(true);
    expect(CLI_VERBS.has("doctor")).toBe(true);
    expect(CLI_VERBS.has("stats")).toBe(true);
    expect(CLI_VERBS.has("help")).toBe(true);
    expect(CLI_VERBS.has("--help")).toBe(true);
    expect(CLI_VERBS.has("-h")).toBe(true);
    expect(CLI_VERBS.has("--version")).toBe(true);
    expect(CLI_VERBS.has("-v")).toBe(true);
  });
});
