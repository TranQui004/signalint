// Focused: short-id + full-id resolution, cluster-id retrieval, and when structuredContent appeared.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = process.argv[2] ?? "pr54";
const dist = join(root, "builds", build, "dist", "src");
const { createIssueId } = await import(join(dist, "schema.js"));

// ------------------------------------------------------------ fresh fixture --
const lab = join(root, "projects", "id-lab");
rmSync(lab, { recursive: true, force: true });
mkdirSync(join(lab, "src"), { recursive: true });
writeFileSync(join(lab, "package.json"), JSON.stringify({ name: "id-lab", private: true, type: "module" }, null, 2));
writeFileSync(
  join(lab, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [] }, include: ["src/**/*.ts"] }, null, 2),
);
writeFileSync(join(lab, ".oxlintrc.json"), JSON.stringify({ rules: { eqeqeq: "warn" } }, null, 2));
writeFileSync(join(lab, "signalint.config.json"), JSON.stringify({ engines: { oxlint: true, tsc: true, biome: false, eslint: false } }, null, 2));
writeFileSync(join(lab, "src", "a.ts"), 'export const one: number = "x";\n');
writeFileSync(join(lab, "src", "b.ts"), 'export const two: string = 5;\nif (1 == 2) {}\n');

const transport = new StdioClientTransport({ command: process.execPath, args: [join(dist, "index.js")], cwd: lab, env: { ...process.env }, stderr: "pipe" });
const client = new Client({ name: "eval-harness", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const call = async (tool, args) => {
  const r = await client.callTool({ name: tool, arguments: args });
  const text = (r.content ?? []).map((c) => c.text ?? "").join("");
  try {
    return { parsed: JSON.parse(text), raw: r };
  } catch {
    return { parsed: { __parseError: text.slice(0, 200) }, raw: r };
  }
};

const { parsed: check1, raw: rawCheck } = await call("check_project", {});
console.log(`\n=== [${build}] check_project on id-lab ===`);
console.log(JSON.stringify({
  totalIssues: check1.totalIssues,
  clusters: (check1.clusters ?? []).map((c) => ({ id: c.clusterId, n: c.issueCount, sample: c.sampleIssueIds })),
  remaining: (check1.remainingIssues ?? check1.remaining ?? []).map((i) => ({ id: i.issueId, len: i.issueId?.length, file: i.file, rule: i.rule })),
}, null, 2));
console.log("wire: text B =", Buffer.byteLength((rawCheck.content ?? []).map((c) => c.text ?? "").join("")),
  "| envelope B =", Buffer.byteLength(JSON.stringify(rawCheck)),
  "| structuredContent:", rawCheck.structuredContent !== undefined ? `${Buffer.byteLength(JSON.stringify(rawCheck.structuredContent))} B` : "absent");

const pool = [
  ...(check1.clusters ?? []).flatMap((c) => c.sampleIssueIds ?? []),
  ...(check1.remainingIssues ?? check1.remaining ?? []).map((i) => i.issueId),
];
const rows = [];
for (const shortId of pool.slice(0, 3)) {
  const byShort = await call("get_issue_detail", { issueId: shortId });
  const first = Array.isArray(byShort.parsed) ? byShort.parsed[0] : byShort.parsed;
  let fullId = null;
  if (first?.file && first?.message) fullId = createIssueId(first.file, first.rule, first.line, first.message);
  const byFull = fullId ? await call("get_issue_detail", { issueId: fullId }) : null;
  rows.push({
    shortId,
    len: shortId.length,
    shortResolves: byShort.parsed?.status !== "stale" && !byShort.parsed?.__parseError,
    fullIdLen: fullId?.length ?? null,
    fullResolves: byFull ? byFull.parsed?.status !== "stale" && !byFull.parsed?.__parseError : null,
    identical: byFull ? JSON.stringify(byShort.parsed) === JSON.stringify(byFull.parsed) : null,
    message: first?.message?.slice(0, 48) ?? null,
  });
}
console.log(`\n=== [${build}] get_issue_detail: short vs full id ===`);
console.table(rows);

// cluster-id retrieval (the documented way to reach omitted issues)
const clusterId = (check1.clusters ?? [])[0]?.clusterId;
if (clusterId !== undefined) {
  const byCluster = await call("get_issue_detail", { clusterId });
  const arr = Array.isArray(byCluster.parsed) ? byCluster.parsed : [byCluster.parsed];
  console.log(`\n=== [${build}] get_issue_detail({clusterId:"${clusterId}"}) ===`);
  console.log(JSON.stringify({ count: arr.length, sample: arr[0] }, null, 2).slice(0, 500));
}

// bogus id must not crash
const bogus = await call("get_issue_detail", { issueId: "deadbeefdead" });
console.log(`\n=== [${build}] get_issue_detail with unknown id ===`);
console.log(JSON.stringify(bogus.parsed).slice(0, 300));

await client.close().catch(() => {});
