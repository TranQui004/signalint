import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** Returns whether a module URL names the executed entrypoint, including through symlinks or junctions. */
export function isMainModule(
  moduleUrl: string,
  entryPath: string | undefined = process.argv[1],
): boolean {
  if (entryPath === undefined) {
    return false;
  }
  return canonicalPath(fileURLToPath(moduleUrl)) === canonicalPath(entryPath);
}

function canonicalPath(path: string): string {
  const absolutePath = resolve(path);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    return absolutePath;
  }
}
