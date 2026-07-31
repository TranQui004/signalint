import { spawn, type ChildProcess } from "node:child_process";

import type {
  EngineOutputLimitResponse,
  IssueEngine,
  TimeoutResponse,
} from "./schema.js";

type ActiveTerminator = () => Promise<void>;

const activeEngineProcesses = new Map<ChildProcess, ActiveTerminator>();

export const DEFAULT_MAX_ENGINE_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface EngineCommandOptions {
  cwd: string;
  engine: IssueEngine;
  maxOutputBytes?: number;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
}

export class EngineTimeoutError extends Error {
  public readonly response: TimeoutResponse;

  /** Creates a structured timeout failure for one engine invocation. */
  public constructor(public readonly engine: IssueEngine, timeoutMs: number) {
    const message = `${engine} did not complete within ${formatDuration(timeoutMs)}`;
    super(message);
    this.name = "EngineTimeoutError";
    this.response = { status: "timeout", engine, message };
  }
}

export class EngineAbortError extends Error {
  /** Creates an internal cancellation failure when an MCP request or connection closes. */
  public constructor(public readonly engine: IssueEngine) {
    super(`${engine} was cancelled`);
    this.name = "EngineAbortError";
  }
}

export class EngineExecutionError extends Error {
  /** Wraps an unexpected adapter failure with the engine that produced it. */
  public constructor(public readonly engine: IssueEngine, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${engine} failed: ${detail}`, { cause });
    this.name = "EngineExecutionError";
  }
}

export class EngineOutputLimitError extends Error {
  public readonly response: EngineOutputLimitResponse;

  /** Creates a structured failure after an engine exceeds its output byte ceiling. */
  public constructor(
    public readonly engine: IssueEngine,
    maxOutputBytes: number,
  ) {
    const message = `${engine} output exceeded the ${formatByteLimit(maxOutputBytes)} limit`;
    super(message);
    this.name = "EngineOutputLimitError";
    this.response = {
      status: "error",
      code: "engine_output_exceeded",
      engine,
      message,
    };
  }
}

/** Preserves known engine errors or wraps an unknown adapter failure with engine identity. */
export function attributeEngineError(engine: IssueEngine, error: unknown): Error {
  return isEngineAttributedError(error) ? error : new EngineExecutionError(engine, error);
}

/** Returns the engine carried by an attributed failure, or undefined for non-engine errors. */
export function readErrorEngine(error: unknown): IssueEngine | undefined {
  return isEngineAttributedError(error) ? error.engine : undefined;
}

/** Runs one engine command with a deadline and kills its full process tree when cancelled. */
export function runEngineCommand(
  command: string,
  args: readonly string[],
  options: EngineCommandOptions,
): Promise<CommandResult> {
  assertTimeout(options.timeoutMs);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_ENGINE_OUTPUT_BYTES;
  assertMaxOutputBytes(maxOutputBytes);
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
    let outputBytes = 0;
    let settled = false;
    let termination: "abort" | "output_limit" | "timeout" | undefined;
    let terminationPromise: Promise<void> | undefined;

    const terminate = (
      reason: "abort" | "output_limit" | "timeout",
    ): Promise<void> => {
      if (terminationPromise !== undefined) {
        return terminationPromise;
      }
      termination = reason;
      terminationPromise = terminateProcessTree(child)
        .catch((error: unknown) => reportTerminationFailure(options.engine, error))
        .finally(finishTermination);
      return terminationPromise;
    };
    const onAbort = (): void => void terminate("abort");
    const timeout = setTimeout(() => void terminate("timeout"), options.timeoutMs);

    activeEngineProcesses.set(child, () => terminate("abort"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      appendOutput(chunk, (value) => {
        stdout += value;
      });
    });
    child.stderr.on("data", (chunk: string) => {
      appendOutput(chunk, (value) => {
        stderr += value;
      });
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
        } else if (termination === "output_limit") {
          reject(new EngineOutputLimitError(options.engine, maxOutputBytes));
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
      activeEngineProcesses.delete(child);
    }

    function appendOutput(chunk: string, append: (value: string) => void): void {
      if (termination !== undefined) {
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (outputBytes + chunkBytes > maxOutputBytes) {
        void terminate("output_limit");
        return;
      }
      outputBytes += chunkBytes;
      append(chunk);
    }
  });
}

/** Terminates every engine process tree still active in this Node process. */
export async function terminateAllEngineProcesses(): Promise<void> {
  const terminators = [...activeEngineProcesses.values()];
  await Promise.all(terminators.map(async (terminate) => await terminate()));
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

function isEngineAttributedError(
  error: unknown,
): error is Error & { readonly engine: IssueEngine } {
  return (
    error instanceof Error &&
    "engine" in error &&
    (error.engine === "oxlint" || error.engine === "tsc" || error.engine === "biome")
  );
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Engine timeout must be a positive integer number of milliseconds.");
  }
}

function assertMaxOutputBytes(maxOutputBytes: number): void {
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new Error("Engine output limit must be a positive integer number of bytes.");
  }
}

function formatDuration(timeoutMs: number): string {
  return timeoutMs % 1000 === 0
    ? `${String(timeoutMs / 1000)}s`
    : `${String(timeoutMs)}ms`;
}

function formatByteLimit(bytes: number): string {
  return bytes % (1024 * 1024) === 0
    ? `${String(bytes / (1024 * 1024))} MiB`
    : `${String(bytes)} byte` + (bytes === 1 ? "" : "s");
}
