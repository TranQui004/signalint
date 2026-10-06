import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { checkProjectWithIssues } from "../dist/src/index.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), "signalint-bench-"));
  try {
    // Copy sample-project fixture to tempDir without mutating repository fixtures
    await cp(resolve("test/fixtures/sample-project"), tempDir, { recursive: true });

    // Write signalint.config.json
    await writeFile(
      join(tempDir, "signalint.config.json"),
      JSON.stringify(
        {
          engines: { oxlint: true, tsc: true, biome: false },
          ignore: ["node_modules/**", "dist/**", ".signalint/**"],
          timeoutsMs: { oxlint: 30000, tsc: 120000, biome: 30000 },
        },
        null,
        2,
      ),
      "utf8",
    );

    // Create 10 files in src with multiple errors and warnings
    const srcDir = join(tempDir, "src");
    await mkdir(srcDir, { recursive: true });
    for (let i = 1; i <= 10; i++) {
      const padded = String(i).padStart(2, "0");
      const content = [
        `var x${padded} = 10;`,
        `let y${padded} = 20;`,
        `export const num${padded}: number = "string-value-${padded}";`,
        `export const val${padded}: boolean = 12345;`,
        `const unused${padded} = true;`,
        "",
      ].join("\n");
      await writeFile(join(srcDir, `file${padded}.ts`), content, "utf8");
    }

    // 1. Measure raw engine outputs
    // Oxlint --format agent
    const oxlintPkg = require.resolve("oxlint/package.json");
    const oxlintCli = resolve(dirname(oxlintPkg), "bin", "oxlint");
    let oxlintRaw = "";
    try {
      const oxResult = await execFileAsync(process.execPath, [oxlintCli, "--format", "agent", "src"], {
        cwd: tempDir,
        windowsHide: true,
      });
      oxlintRaw = oxResult.stdout + oxResult.stderr;
    } catch (err) {
      oxlintRaw = (err.stdout ?? "") + (err.stderr ?? "");
    }

    // Tsc --pretty false
    const tscPkg = require.resolve("typescript/package.json");
    const tscCli = resolve(dirname(tscPkg), "bin", "tsc");
    let tscRaw = "";
    try {
      const tscResult = await execFileAsync(
        process.execPath,
        [tscCli, "--pretty", "false", "--noEmit"],
        {
          cwd: tempDir,
          windowsHide: true,
        },
      );
      tscRaw = tscResult.stdout + tscResult.stderr;
    } catch (err) {
      tscRaw = (err.stdout ?? "") + (err.stderr ?? "");
    }

    const rawTotalText = `${oxlintRaw.trim()}\n${tscRaw.trim()}`.trim();
    const rawBytes = Buffer.byteLength(rawTotalText, "utf8");

    // 2. Measure Signalint normalized issues and clustered response
    const { issues, response } = await checkProjectWithIssues(["."], tempDir);
    const normalizedJson = JSON.stringify(issues, null, 2);
    const normalizedBytes = Buffer.byteLength(normalizedJson, "utf8");

    const clusteredJson = JSON.stringify(response, null, 2);
    const clusteredBytes = Buffer.byteLength(clusteredJson, "utf8");

    const reductionFromRaw = (((rawBytes - clusteredBytes) / rawBytes) * 100).toFixed(1);
    const reductionFromNormalized = (((normalizedBytes - clusteredBytes) / normalizedBytes) * 100).toFixed(1);

    console.log("=== Signalint Compression Benchmark ===");
    console.log(`Issues detected:           ${issues.length}`);
    console.log(`Clusters returned:         ${response.clusters.length}`);
    console.log(`(a) Raw engine output:     ${rawBytes.toLocaleString("en-US")} bytes (oxlint --format agent + tsc --pretty false)`);
    console.log(`(b) Signalint normalized:  ${normalizedBytes.toLocaleString("en-US")} bytes (JSON)`);
    console.log(`(c) Signalint clustered:   ${clusteredBytes.toLocaleString("en-US")} bytes (JSON)`);
    console.log(`Reduction vs raw:          ${reductionFromRaw}%`);
    console.log(`Reduction vs normalized:   ${reductionFromNormalized}%`);

    return {
      rawBytes,
      normalizedBytes,
      clusteredBytes,
      reductionFromRaw,
      reductionFromNormalized,
      totalIssues: issues.length,
      clusterCount: response.clusters.length,
      sampleResponse: response,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
