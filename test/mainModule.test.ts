import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isMainModule } from "../src/mainModule.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("main-module detection", () => {
  it("recognizes an npm-link-style symlinked or junction entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "signalint-main-module-"));
    temporaryRoots.push(root);
    const realDirectory = join(root, "real-package");
    const linkedDirectory = join(root, "linked-package");
    const realEntry = join(realDirectory, "entry.js");
    const linkedEntry = join(linkedDirectory, "entry.js");
    await mkdir(realDirectory);
    await writeFile(realEntry, "export {};\n", "utf8");
    await symlink(
      realDirectory,
      linkedDirectory,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(isMainModule(pathToFileURL(realEntry).href, linkedEntry)).toBe(true);
  });

  it("rejects an unrelated entrypoint", () => {
    expect(isMainModule(import.meta.url, join(tmpdir(), "signalint-unrelated-entry.js"))).toBe(false);
  });
});
