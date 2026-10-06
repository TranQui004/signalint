import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "./util/index.js";

/** npm package name used to recognize Signalint's own package metadata. */
const PACKAGE_NAME = "signalint-mcp";

let cachedVersion: string | undefined;

/**
 * Resolves the installed Signalint version from the nearest `package.json`
 * that identifies itself as `signalint-mcp`, walking up from this module.
 *
 * The version is reported to MCP clients during initialization and is part of
 * the cache key, so it must follow the published package instead of being
 * hardcoded. The result is memoized for the process lifetime.
 */
export function resolveSignalintVersion(): string {
  if (cachedVersion !== undefined) {
    return cachedVersion;
  }

  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const packagePath = resolve(directory, "package.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
      if (isRecord(parsed) && parsed.name === PACKAGE_NAME && typeof parsed.version === "string") {
        cachedVersion = parsed.version;
        return cachedVersion;
      }
    } catch {
      // Missing or unparsable package.json: keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  throw new Error("Could not resolve the installed signalint-mcp package version.");
}
