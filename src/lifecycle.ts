import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { closeAllSqliteCaches } from "./cache/sqliteCache.js";
import { terminateAllEngineProcesses } from "./subprocess.js";

/** Closes engine process trees, SQLite handles, and the MCP transport in shutdown order. */
export async function closeRuntimeResources(server: Server): Promise<void> {
  await terminateAllEngineProcesses();
  closeAllSqliteCaches();
  await server.close();
}

/** Registers signal and fatal-error handlers that clean resources before exiting. */
export function registerProcessLifecycle(server: Server): () => void {
  let shuttingDown = false;

  const shutdown = (exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void closeRuntimeResources(server)
      .then(() => process.exit(exitCode))
      .catch((error: unknown) => {
        writeFatalError("shutdown failed", error);
        process.exit(1);
      });
  };
  const onSigint = (): void => shutdown(0);
  const onSigterm = (): void => shutdown(0);
  const onUnhandledRejection = (reason: unknown): void => {
    writeFatalError("unhandled rejection", reason);
    shutdown(1);
  };
  const onUncaughtException = (error: unknown): void => {
    writeFatalError("uncaught exception", error);
    shutdown(1);
  };

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  process.once("unhandledRejection", onUnhandledRejection);
  process.once("uncaughtException", onUncaughtException);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
  };
}

/** Writes a fatal server failure and includes a stack trace when one exists. */
export function writeFatalError(context: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[signalint] ${context}: ${detail}\n`);
}
