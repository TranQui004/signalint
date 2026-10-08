// Round 4c: cache staleness, check_files scope, loop detection and issue-detail retrieval
// through a SINGLE long-lived MCP server — the real agent loop.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, rmSync, writeFileSync, statSync, utimesSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lab = join(root, "projects", "cache-lab");
const resultsDir = join(root, "results");
mkdirSync(resultsDir, { recursive: true });

// ---------------------------------------------------------------- fixture ---
function writeFixture() {
  rmSync(lab, { recursive: true, force: true });
  mkdirSync(join(lab, "src"), { recursive: true });
  writeFileSync(join(lab, "package.json"), JSON.stringify({ name: "cache-lab", private: true, type: "module" }, null, 2));
  writeFileSync(
    join(lab, "tsconfig.json"),
    JSON.stringify(
      { compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [] }, include: ["src/**/*.ts"] },
      null,
      2,
    ),
  );
  writeFileSync(join(lab, ".oxlintrc.json"), JSON.stringify({ rules: { eqeqeq: "warn" } }, null, 2));
  writeFileSync(
    join(lab, "signalint.config.json"),
    JSON.stringify({ engines: { oxlint: true, tsc: true, biome: false, eslint: false } }, null, 2),
  );
  writeFileSync(join(lab, "src", "types.ts"), "export type UserName = string;\n");
  writeFileSync(
    join(lab, "src", "consumer.ts"),
    'import type { UserName } from "./types";\n\nexport const count: number = "nope";\nexport const name: UserName = "ada";\n',
  );
  writeFileSync(join(lab, "src", "other.ts"), "export const v: number = 1;\n");
  writeFileSync(join(lab, "src", "clean.ts"), 'export const ok: string = "fine";\n');
}
writeFixture();

// ------------------------------------------------------------------ client --
const entry = join(root, "builds", "pr52", "dist", "src", "index.js");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd: lab,
  env: { ...process.env },
  stderr: "pipe",
});
const client = new Client({ name: "eval-harness", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const parse = (result) => {
  const text = (result.content ?? []).map((c) => c.text ?? "").join("");
  try {
    return JSON.parse(text);
  } catch {
    return { __parseError: text.slice(0, 200) };
  }
};
const check = async () => parse(await client.callTool({ name: "check_project", arguments: {} }));
const checkFiles = async (files) =>
  parse(await client.callTool({ name: "check_files", arguments: { files } }));

const summarize = (r) => {
  const files = new Set();
  for (const c of r.clusters ?? []) for (const f of c.files ?? []) files.add(f);
  for (const i of r.remainingIssues ?? r.remaining ?? []) files.add(i.file);
  return {
    total: r.totalIssues ?? null,
    clusters: (r.clusters ?? []).length,
    remaining: (r.remainingIssues ?? r.remaining ?? []).length,
    omitted: r.omittedIssueCount ?? r.omitted ?? 0,
    files: [...files].sort(),
    rules: [...new Set((r.remainingIssues ?? r.remaining ?? []).map((i) => i.rule))].sort(),
  };
};

const log = [];
const step = async (label, fn, expectation) => {
  const started = Date.now();
  const summary = await fn();
  log.push({ step: label, ms: Date.now() - started, ...summary, expectation });
  console.log(`\n### ${label}  (${Date.now() - started} ms)`);
  console.log(JSON.stringify(summary));
  console.log(`expect: ${expectation}`);
  return summary;
};

// ------------------------------------------------------------------ steps ---
await step("S0 baseline (cold)", check, "TS2322 in consumer.ts");

writeFileSync(join(lab, "src", "consumer.ts"), 'import type { UserName } from "./types";\n\nexport const count: number = 7;\nexport const name: UserName = "ada";\n');
await step("S1 fixed the TS2322", check, "TS2322 gone");

writeFileSync(join(lab, "src", "clean.ts"), 'export const ok: string = "fine";\nexport const bad: number = "x";\n');
await step("S2 added error to previously clean file", check, "new TS2322 in clean.ts");

writeFileSync(join(lab, "src", "types.ts"), "export type UserName = number;\n");
await step("S3 cross-file: types.ts type changed", check, "new error in consumer.ts (name: UserName = \"ada\")");

// Coarse-mtime filesystem simulation: same byte size + restored mtime.
const typesPath = join(lab, "src", "types.ts");
const before = statSync(typesPath);
const oldContent = readFileSync(typesPath, "utf8");
const newContent = oldContent.replace("UserName", "UserNamf"); // same length, breaks the import
writeFileSync(typesPath, newContent);
utimesSync(typesPath, before.atime, before.mtime);
await step("S4 same-size edit + mtime restored (coarse-mtime FS)", check, "fresh: TS2305 appears in consumer.ts");

const touched = statSync(typesPath);
utimesSync(typesPath, touched.atime, new Date(Date.now() + 1000));
await step("S5 after mtime bump (control)", check, "TS2305 appears now");

await step("S6 check_files([consumer.ts]) scope", () => checkFiles(["src/consumer.ts"]), "only consumer.ts issues (no scope leak)");

const loop = [];
for (let i = 0; i < 3; i += 1) loop.push(summarize(await check()));
const loopStatus = parse(await client.callTool({ name: "get_loop_status", arguments: {} }));
console.log("\n### S7 loop detection after 3 identical re-checks");
console.log(JSON.stringify({ runs: loop.map((l) => l.total), loopStatus }, null, 2));
log.push({ step: "S7 loop status", loopStatus });

// Issue-detail retrieval for a flat remaining record and for a cluster sample.
const after = await check();
const remaining = after.remainingIssues ?? after.remaining ?? [];
const sampleId = remaining[0]?.issueId ?? (after.clusters ?? [])[0]?.sampleIssueIds?.[0];
let detail = null;
if (sampleId !== undefined) {
  detail = parse(await client.callTool({ name: "get_issue_detail", arguments: { issueId: sampleId } }));
}
console.log("\n### S8 get_issue_detail on a payload issueId");
console.log(JSON.stringify(detail, null, 2).slice(0, 800));
log.push({ step: "S8 get_issue_detail", ok: detail?.status !== "stale", detail });

await client.close().catch(() => {});
writeFileSync(join(resultsDir, "round4-cache.json"), JSON.stringify(log, null, 2));
console.log("\nwritten:", join(resultsDir, "round4-cache.json"));
