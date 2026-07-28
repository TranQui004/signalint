import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "../src/index.js";
import { EngineTimeoutError, runEngineCommand } from "../src/subprocess.js";

interface PidRecord {
  parent: number;
  child: number;
}

interface TaskkillResult {
  exitCode: number | null;
  stderr: string;
}

const fixturePath = resolve("test/fixtures/hanging-process.cjs");
const pidDirectory = resolve(".signalint/test");
const timeoutPidPath = resolve(pidDirectory, "timeout-pids.json");
const disconnectPidPath = resolve(pidDirectory, "disconnect-pids.json");
const permissionPidPath = resolve(pidDirectory, "taskkill-permission-pids.json");
const pidPaths = [timeoutPidPath, disconnectPidPath, permissionPidPath];
const clients: Client[] = [];
const servers: Server[] = [];
let taskkillPermissionDenied = false;

beforeAll(async () => {
  await mkdir(pidDirectory, { recursive: true });
  if (process.platform !== "win32") {
    return;
  }
  await rm(permissionPidPath, { force: true });
  const fixture = spawn(process.execPath, [fixturePath, permissionPidPath], {
    stdio: "ignore",
    windowsHide: true,
  });
  fixture.unref();
  await waitUntil(async () => await fileExists(permissionPidPath));
  const pids = await readPidRecord(permissionPidPath);
  const result = await runTaskkill(pids.parent);
  taskkillPermissionDenied = isAccessDenied(result);
  if (taskkillPermissionDenied) {
    forceKillDirectly(pids.parent);
    forceKillDirectly(pids.child);
  } else if (result.exitCode !== 0) {
    throw new Error(`taskkill permission preflight failed: ${result.stderr.trim()}`);
  }
  await rm(permissionPidPath, { force: true });
});

afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await Promise.all(servers.map((server) => server.close()));
  clients.length = 0;
  servers.length = 0;
  for (const path of pidPaths) {
    await cleanPidFixture(path);
  }
});

describe("Engine subprocess lifecycle", () => {
  it("returns a structured timeout and kills the engine process tree", async ({ skip }) => {
    if (taskkillPermissionDenied) {
      skip("taskkill permission denied in this environment");
      return;
    }
    await rm(timeoutPidPath, { force: true });

    await expect(
      runEngineCommand(process.execPath, [fixturePath, timeoutPidPath], {
        cwd: process.cwd(),
        engine: "oxlint",
        timeoutMs: 500,
      }),
    ).rejects.toEqual(new EngineTimeoutError("oxlint", 500));

    const pids = await readPidRecord(timeoutPidPath);
    await waitUntil(() => !isProcessRunning(pids.parent) && !isProcessRunning(pids.child));
    expect(isProcessRunning(pids.parent)).toBe(false);
    expect(isProcessRunning(pids.child)).toBe(false);
  });

  it("kills the engine process tree when the MCP connection closes", async ({ skip }) => {
    if (taskkillPermissionDenied) {
      skip("taskkill permission denied in this environment");
      return;
    }
    await rm(disconnectPidPath, { force: true });
    const server = createServer({
      projectIssueProvider: async (_paths, signal) => {
        await runEngineCommand(process.execPath, [fixturePath, disconnectPidPath], {
          cwd: process.cwd(),
          engine: "biome",
          signal,
          timeoutMs: 10_000,
        });
        return [];
      },
    });
    servers.push(server);
    const client = await connectClient(server);
    const pendingCheck = client.callTool({
      name: "check_project",
      arguments: { paths: ["."] },
    });
    await waitUntil(async () => await fileExists(disconnectPidPath));
    const pids = await readPidRecord(disconnectPidPath);

    await client.close();
    clients.splice(clients.indexOf(client), 1);
    await pendingCheck.catch(() => undefined);
    await waitUntil(() => !isProcessRunning(pids.parent) && !isProcessRunning(pids.child));

    expect(isProcessRunning(pids.parent)).toBe(false);
    expect(isProcessRunning(pids.child)).toBe(false);
  });
});

async function connectClient(server: Server): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "signalint-subprocess-test", version: "1.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

async function readPidRecord(path: string): Promise<PidRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isRecord(parsed) ||
    !Number.isInteger(parsed.parent) ||
    !Number.isInteger(parsed.child)
  ) {
    throw new Error("Hanging-process fixture did not write valid PIDs.");
  }
  return { parent: parsed.parent as number, child: parsed.child as number };
}

async function cleanPidFixture(path: string): Promise<void> {
  try {
    const pids = await readPidRecord(path);
    await forceKill(pids.parent);
    await forceKill(pids.child);
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  } finally {
    await rm(path, { force: true });
  }
}

function forceKill(pid: number): Promise<void> {
  if (!isProcessRunning(pid)) {
    return Promise.resolve();
  }
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return Promise.resolve();
    }
    return Promise.resolve();
  }
  return runTaskkill(pid).then((result) => {
    if (result.exitCode !== 0) {
      forceKillDirectly(pid);
    }
  });
}

function runTaskkill(pid: number): Promise<TaskkillResult> {
  return new Promise((resolveResult) => {
    let stderr = "";
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    killer.stderr.setEncoding("utf8");
    killer.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    killer.on("error", (error) => {
      resolveResult({ exitCode: null, stderr: error.message });
    });
    killer.on("close", (exitCode) => {
      resolveResult({ exitCode, stderr });
    });
  });
}

function isAccessDenied(result: TaskkillResult): boolean {
  return (
    result.exitCode !== 0 &&
    /(?:access\s+is\s+denied|access\s+denied|permission\s+denied)/i.test(result.stderr)
  );
}

function forceKillDirectly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for subprocess state.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
