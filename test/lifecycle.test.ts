import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteCache } from "../src/cache/sqliteCache.js";
import {
  closeRuntimeResources,
  registerProcessLifecycle,
  writeFatalError,
} from "../src/lifecycle.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP process lifecycle", () => {
  it("registers and removes signal and fatal-error handlers", () => {
    const server = createServerStub();
    const before = readListenerCounts();

    const unregister = registerProcessLifecycle(server);

    expect(readListenerCounts()).toEqual({
      SIGINT: before.SIGINT + 1,
      SIGTERM: before.SIGTERM + 1,
      unhandledRejection: before.unhandledRejection + 1,
      uncaughtException: before.uncaughtException + 1,
    });

    unregister();
    expect(readListenerCounts()).toEqual(before);
  });

  it("closes every open SQLite handle and the MCP transport", async () => {
    const cache = new SqliteCache(":memory:");
    const server = createServerStub();

    await closeRuntimeResources(server);

    expect(server.close).toHaveBeenCalledOnce();
    expect(() => cache.get("missing")).toThrow();
    expect(() => cache.close()).not.toThrow();
  });

  it("logs fatal errors to stderr with their stack trace", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const error = new Error("fatal fixture");

    writeFatalError("uncaught exception", error);

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("uncaught exception"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("fatal fixture"));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Error: fatal fixture"));
  });
});

function createServerStub(): Server {
  return {
    close: vi.fn(() => Promise.resolve()),
  } as unknown as Server;
}

function readListenerCounts(): {
  SIGINT: number;
  SIGTERM: number;
  unhandledRejection: number;
  uncaughtException: number;
} {
  return {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
    unhandledRejection: process.listenerCount("unhandledRejection"),
    uncaughtException: process.listenerCount("uncaughtException"),
  };
}
