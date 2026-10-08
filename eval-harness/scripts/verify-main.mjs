// Verifies PR A (compact + minify, now merged in main) and PR B (check_files scope).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = process.argv[2] ?? "main";
const dist = join(root, "builds", build, "dist", "src");
const cli = join(dist, "cli.js");
const serverEntry = join(dist, "index.js");
const projectsDir = join(root, "projects");
const resultsDir = join(root, "results");
mkdirSync(resultsDir, { recursive: true });

const run = (args, cwd, env) => {
  try {
    return execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...(env ?? {}) } });
  } catch (e) {
    return e.stdout ?? "";
  }
};
const tok = (t) => encode(t).length;

// ---------------------------------------------------- 1. compact vs normal ---
const compactRows = [];
for (const project of ["sparse", "systemic-ts", "mixed-app", "scale-app"]) {
  const cwd = join(projectsDir, project);
  rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
  const normal = run([cli, "check", "."], cwd, {}).trim();
  rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
  const compact = run([cli, "check", "."], cwd, { SIGNALINT_COMPACT: "1" }).trim();
  let n = null;
  let c = null;
  try {
    n = JSON.parse(normal);
    c = JSON.parse(compact);
  } catch {
    /* ignore */
  }
  const nB = Buffer.byteLength(normal);
  const cB = Buffer.byteLength(compact);
  const dupShort = c ? ["remaining", "remainingIssues"].filter((k) => k in c) : [];
  compactRows.push({
    project,
    issues: n?.totalIssues ?? null,
    normalB: nB,
    compactB: cB,
    compactSmaller: cB < nB,
    delta: `${(((cB - nB) / nB) * 100).toFixed(0)}%`,
    dupKeys: dupShort.join("+") || "none",
    compactKeys: c ? Object.keys(c).sort().join(",") : "?",
    normalTok: tok(normal),
    compactTok: tok(compact),
  });
}
console.log(`\n=== [${build}] 1. compact mode vs normal (CLI) ===`);
console.table(compactRows);

// -------------------------------------------- 2. MCP envelope / minify check ---
async function mcpCall(cwd, tool, args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd,
    env: { ...process.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "eval-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await client.callTool({ name: tool, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

const wireRows = [];
for (const project of ["sparse", "systemic-ts", "mixed-app", "scale-app"]) {
  const cwd = join(projectsDir, project);
  rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
  const result = await mcpCall(cwd, "check_project", {});
  const text = (result.content ?? []).map((c) => c.text ?? "").join("");
  const whole = JSON.stringify(result);
  wireRows.push({
    project,
    textB: Buffer.byteLength(text),
    envelopeB: Buffer.byteLength(whole),
    ratio: (Buffer.byteLength(whole) / Math.max(Buffer.byteLength(text), 1)).toFixed(2) + "x",
    hasNewline: text.includes("\n"),
    textTok: tok(text),
    structured: result.structuredContent !== undefined ? "yes" : "no",
    structuredB: result.structuredContent ? Buffer.byteLength(JSON.stringify(result.structuredContent)) : 0,
  });
}
console.log(`\n=== [${build}] 2. MCP wire (is the payload minified? is it duplicated?) ===`);
console.table(wireRows);

// ------------------------------------------------- 3. check_files scope (PR B) ---
const lab = join(projectsDir, "cache-lab");
if (readFileSync(join(lab, "src", "types.ts"), "utf8").includes("UserNamf")) {
  // reset fixture to the known multi-error state
  writeFileSync(join(lab, "src", "types.ts"), "export type UserName = string;\n");
  writeFileSync(join(lab, "src", "consumer.ts"), 'import type { UserName } from "./types";\n\nexport const count: number = "nope";\nexport const name: UserName = "ada";\n');
  writeFileSync(join(lab, "src", "clean.ts"), 'export const ok: string = "fine";\nexport const bad: number = "x";\n');
  writeFileSync(join(lab, "src", "other.ts"), "export const v: number = 1;\n");
}
rmSync(join(lab, ".signalint"), { recursive: true, force: true });
const scope = await mcpCall(lab, "check_files", { files: ["src/consumer.ts"] });
const scopeParsed = JSON.parse((scope.content ?? []).map((c) => c.text ?? "").join(""));
const filesSeen = [
  ...(scopeParsed.clusters ?? []).flatMap((cl) => cl.files ?? []),
  ...(scopeParsed.remainingIssues ?? scopeParsed.remaining ?? []).map((i) => i.file),
];
const scopeAgain = JSON.parse(
  (await mcpCall(lab, "check_files", { files: ["src/consumer.ts"] })).content.map((c) => c.text ?? "").join(""),
);
const projectAll = JSON.parse(
  (await mcpCall(lab, "check_project", {})).content.map((c) => c.text ?? "").join(""),
);

const scopeReport = {
  requested: "src/consumer.ts",
  total: scopeParsed.totalIssues,
  filesInPayload: [...new Set(filesSeen)].sort(),
  filteredOutIssueCount: scopeParsed.filteredOutIssueCount ?? scopeParsed.filteredOutCount ?? scopeParsed.filteredOut ?? null,
  nextStep: scopeParsed.nextStep ?? null,
  warmIdentical: JSON.stringify(scopeParsed) === JSON.stringify(scopeAgain),
  checkProjectTotal: projectAll.totalIssues,
  scopeLeak: [...new Set(filesSeen)].some((f) => f !== "src/consumer.ts"),
};
console.log(`\n=== [${build}] 3. check_files scope (PR B) ===`);
console.log(JSON.stringify(scopeReport, null, 2));

writeFileSync(
  join(resultsDir, `verify-${build}.json`),
  JSON.stringify({ compactRows, wireRows, scopeReport }, null, 2),
);
console.log("\nwritten:", join(resultsDir, `verify-${build}.json`));
