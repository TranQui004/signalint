import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { checkFilesWithStats } from "../src/checkFiles.js";
import { createServer } from "../src/server/createServer.js";
import { createProgressReporter } from "../src/server/createServer.js";
import {
  EngineAbortError,
  runEngineCommand,
} from "../src/subprocess.js";

interface PidRecord {
  parent: number;
  child: number;
}

const fixturePath = resolve("test/fixtures/hanging-process.cjs");
const testDir = mkdtempSync(resolve(tmpdir(), "signalint-test-cancel-progress-"));
const cancelPidPath = resolve(testDir, "cancel-pids.json");
const clients: Client[] = [];
const servers: Server[] = [];

afterAll(async () => {
  await rm(testDir, { force: true, recursive: true });
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
  clients.length = 0;
  servers.length = 0;
  await rm(cancelPidPath, { force: true });
});

describe("MCP progress reporting", () => {
  it("emits monotonic progress notifications when onprogress callback is registered", async () => {
    const progressUpdates: number[] = [];
    const server = createServer({
      fileIssueProvider: async (_files, signal) => {
        // Simulate small delay for async operations
        await new Promise((res) => setTimeout(res, 20));
        if (signal?.aborted) {
          throw new Error("Aborted");
        }
        return {
          issues: [],
          cache: { hits: 0, misses: 1 },
          engines: { oxlint: { status: "ok" } },
        };
      },
    });
    servers.push(server);

    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "progress-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    const result = await client.callTool(
      { name: "check_files", arguments: { files: ["package.json"] } },
      undefined,
      {
        onprogress: (progress) => {
          progressUpdates.push(progress.progress);
        },
      },
    );

    expect(result).toBeDefined();
    expect(progressUpdates.length).toBeGreaterThanOrEqual(2);
    expect(progressUpdates[0]).toBe(0);
    expect(progressUpdates[progressUpdates.length - 1]).toBe(100);

    // Verify monotonic progression
    for (let i = 1; i < progressUpdates.length; i++) {
      const prev = progressUpdates[i - 1];
      const curr = progressUpdates[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    }
  });

  it("delivers notifications/progress with client-provided progressToken", async () => {
    const receivedTokens: (string | number)[] = [];
    const receivedProgress: number[] = [];

    const server = createServer({
      projectIssueProvider: async () => {
        await new Promise((res) => setTimeout(res, 10));
        return {
          issues: [],
          cache: { hits: 0, misses: 1 },
          engines: { oxlint: { status: "ok" } },
        };
      },
    });
    servers.push(server);

    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "token-client", version: "1.0.0" });
    clients.push(client);

    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      receivedTokens.push(notification.params.progressToken);
      receivedProgress.push(notification.params.progress);
    });

    await client.connect(cT);

    const targetToken = "custom-token-xyz";
    await client.callTool({
      name: "check_project",
      arguments: { paths: ["."] },
      _meta: { progressToken: targetToken },
    });

    expect(receivedTokens.length).toBeGreaterThanOrEqual(2);
    for (const token of receivedTokens) {
      expect(token).toBe(targetToken);
    }
    expect(receivedProgress[0]).toBe(0);
    expect(receivedProgress[receivedProgress.length - 1]).toBe(100);
  });

  it("enforces monotonic updates, rate-limiting, and terminal finish in createProgressReporter", async () => {
    const notifications: Array<{ progress: number; total?: number; message?: string }> = [];
    const mockServer = {
      notification: (notif: { params: { progress: number; total?: number; message?: string } }) => {
        notifications.push(notif.params);
        return Promise.resolve();
      },
    } as unknown as Server;

    const reporter = createProgressReporter(mockServer, "test-token");

    // Initial 0%
    await reporter(0, 100, "Starting");
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.progress).toBe(0);

    // Non-monotonic backward progress should be ignored
    await reporter(-10, 100, "Should be ignored");
    expect(notifications.length).toBe(1);

    // Wait 60ms so rate limiter permits next update
    await new Promise((res) => setTimeout(res, 60));

    // Intermediate update 1 should succeed
    await reporter(10, 100, "Fast update 1");
    expect(notifications.length).toBe(2);
    expect(notifications[1]?.progress).toBe(10);

    // Intermediate update 2 within 50ms should be dropped by rate limiter
    await reporter(20, 100, "Fast update 2");
    expect(notifications.length).toBe(2);

    // Terminal 100% is always delivered
    await reporter(100, 100, "Done");
    expect(notifications.length).toBe(3);
    expect(notifications[2]?.progress).toBe(100);

    // Subsequent updates after terminal are ignored
    await reporter(100, 100, "After finish");
    expect(notifications.length).toBe(3);

    // Explicit finish() stops any more updates
    reporter.finish();
    await reporter(50, 100, "Ignored");
    expect(notifications.length).toBe(3);
  });
});

describe("Cancellation handling", () => {
  it("aborts in-flight check and rejects cleanly without emitting normal tool response", async () => {
    const abortController = new AbortController();
    let providerStarted = false;

    const server = createServer({
      fileIssueProvider: (_files, signal) => {
        providerStarted = true;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("Check cancelled by client signal"));
          });
        });
      },
    });
    servers.push(server);

    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "cancel-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    const pendingCheck = client.callTool(
      { name: "check_files", arguments: { files: ["package.json"] } },
      undefined,
      { signal: abortController.signal },
    );

    // Wait until provider has started
    await waitUntil(() => providerStarted);

    // Abort the request
    abortController.abort();

    // Verify rejection - must NOT resolve with a clean status
    await expect(pendingCheck).rejects.toThrow();
  });

  it("immediately rejects when signal is pre-aborted before check starts", async () => {
    const abortedSignal = AbortSignal.abort("Pre-aborted request");

    await expect(
      checkFilesWithStats(["package.json"], {
        signal: abortedSignal,
      }),
    ).rejects.toThrow("Pre-aborted request");
  });

  it("terminates engine subprocess tree when signal aborts during execution", async () => {
    const abortController = new AbortController();

    const pendingCommand = runEngineCommand(
      process.execPath,
      [fixturePath, cancelPidPath],
      {
        cwd: process.cwd(),
        engine: "biome",
        signal: abortController.signal,
        timeoutMs: 10_000,
      },
    );

    await waitUntil(async () => await fileExists(cancelPidPath));
    const pids = await readPidRecord(cancelPidPath);
    expect(isProcessRunning(pids.parent)).toBe(true);

    // Abort execution
    abortController.abort();

    await expect(pendingCommand).rejects.toBeInstanceOf(EngineAbortError);

    // Verify process tree was terminated
    await waitUntil(() => !isProcessRunning(pids.parent) && !isProcessRunning(pids.child));
    expect(isProcessRunning(pids.parent)).toBe(false);
    expect(isProcessRunning(pids.child)).toBe(false);
  });

  it("handles cancellation in after_edit_check cleanly", async () => {
    const abortController = new AbortController();
    let providerStarted = false;

    const server = createServer({
      fileIssueProvider: (_files, signal) => {
        providerStarted = true;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("after_edit_check cancelled"));
          });
        });
      },
    });
    servers.push(server);

    const [cT, sT] = InMemoryTransport.createLinkedPair();
    await server.connect(sT);
    const client = new Client({ name: "after-edit-cancel-client", version: "1.0.0" });
    clients.push(client);
    await client.connect(cT);

    const pendingEditCheck = client.callTool(
      {
        name: "after_edit_check",
        arguments: { files: ["package.json"] },
      },
      undefined,
      { signal: abortController.signal },
    );

    await waitUntil(() => providerStarted);
    abortController.abort();

    await expect(pendingEditCheck).rejects.toThrow();
  });
});

async function readPidRecord(path: string): Promise<PidRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isRecord(parsed) ||
    !Number.isInteger(parsed["parent"]) ||
    !Number.isInteger(parsed["child"])
  ) {
    throw new Error("Hanging-process fixture did not write valid PIDs.");
  }
  return { parent: parsed["parent"] as number, child: parsed["child"] as number };
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
  const deadline = Date.now() + 4_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
