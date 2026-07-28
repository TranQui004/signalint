import { spawn, type ChildProcess } from "node:child_process";

import type { IssueEngine, TimeoutResponse } from "./schema.js";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface EngineCommandOptions {
  cwd: string;
  engine: IssueEngine;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}

export class EngineTimeoutError extends Error {
  public readonly response: TimeoutResponse;

  /** Creates a structured timeout failure for one engine invocation. */
  public constructor(engine: IssueEngine, timeoutMs: number) {
    const message = `${engine} did not complete within ${formatDuration(timeoutMs)}`;
    super(message);
    this.name = "EngineTimeoutError";
    this.response = { status: "timeout", engine, message };
  }
}

export class EngineAbortError extends Error {
  /** Creates an internal cancellation failure when an MCP request or connection closes. */
  public constructor(engine: IssueEngine) {
    super(`${engine} was cancelled`);
    this.name = "EngineAbortError";
  }
}

/** Runs one engine command with a deadline and kills its full process tree when cancelled. */
export function runEngineCommand(
  command: string,
  args: readonly string[],
  options: EngineCommandOptions,
): Promise<CommandResult> {
  assertTimeout(options.timeoutMs);
  if (options.signal?.aborted === true) {
    return Promise.reject(new EngineAbortError(options.engine));
  }

  return new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      stdio: "pipe",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let termination: "abort" | "timeout" | undefined;

    const terminate = (reason: "abort" | "timeout"): void => {
      if (termination !== undefined) {
        return;
      }
      termination = reason;
      void terminateProcessTree(child)
        .catch((error: unknown) => reportTerminationFailure(options.engine, error))
        .finally(finishTermination);
    };
    const onAbort = (): void => terminate("abort");
    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("close", (exitCode) => {
      if (termination !== undefined) {
        finishTermination();
      } else {
        settle(() => resolveResult({ exitCode, stdout, stderr }));
      }
    });

    function finishTermination(): void {
      releaseChildHandles(child);
      settle(() => {
        if (termination === "timeout") {
          reject(new EngineTimeoutError(options.engine, options.timeoutMs));
        } else {
          reject(new EngineAbortError(options.engine));
        }
      });
    }

    function settle(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      action();
    }

    function cleanup(): void {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  });
}

function releaseChildHandles(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(pid, child);
    return;
  }
  terminatePosixProcessGroup(pid, child);
}

function terminatePosixProcessGroup(pid: number, child: ChildProcess): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error: unknown) {
    if (isErrnoException(error) && error.code === "ESRCH") {
      return;
    }
    child.kill("SIGKILL");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`process-group kill failed for PID ${String(pid)}: ${message}`);
  }
}

function terminateWindowsProcessTree(pid: number, child: ChildProcess): Promise<void> {
  return new Promise((resolveTermination, rejectTermination) => {
    let stderr = "";
    let settled = false;
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    killer.stderr.setEncoding("utf8");
    killer.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    killer.on("error", (error) => {
      child.kill("SIGKILL");
      settle(() => rejectTermination(error));
    });
    killer.on("close", (exitCode) => {
      if (exitCode === 0 || child.exitCode !== null || child.signalCode !== null) {
        settle(resolveTermination);
        return;
      }
      child.kill("SIGKILL");
      settle(() =>
        rejectTermination(new Error(
          `taskkill exited with ${String(exitCode)}: ${stderr.trim() || "unknown error"}`,
        )),
      );
    });

    function settle(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      action();
    }
  });
}

function reportTerminationFailure(engine: IssueEngine, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[signalint] Failed to terminate ${engine} process tree: ${message}\n`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Engine timeout must be a positive integer number of milliseconds.");
  }
}

function formatDuration(timeoutMs: number): string {
  return timeoutMs % 1000 === 0
    ? `${String(timeoutMs / 1000)}s`
    : `${String(timeoutMs)}ms`;
}
