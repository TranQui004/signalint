// Verifies PR #54: short issue ids, compact mode, wire cost, and the claimed benchmark table.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = process.argv[2] ?? "pr54";
const dist = join(root, "builds", build, "dist", "src");
const resultsDir = join(root, "results");
mkdirSync(resultsDir, { recursive: true });

const { createIssueId } = await import(join(dist, "schema.js"));
const tok = (t) => encode(t).length;
const run = (args, cwd, env) => {
  try {
    return execFileSync(process.execPath, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, ...(env ?? {}) } });
  } catch (e) {
    return e.stdout ?? "";
  }
};

// Agent-reported numbers from docs/benchmarks.md (PR #54) — measured on their fixtures.
const claimed = {
  sparse: { payload: 377, envelope: 910 },
  "systemic-ts": { payload: 445, envelope: 1048 },
  "mixed-app": { payload: 1194, envelope: 2280 },
  "scale-app": { payload: 3099, envelope: 5900 },
};

async function mcpCall(cwd, tool, args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dist, "index.js")],
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

const rows = [];
const idReport = {};
for (const project of ["sparse", "systemic-ts", "mixed-app", "scale-app"]) {
  const cwd = join(root, "projects", project);
  rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
  const pretty = run([join(dist, "cli.js"), "check", "."], cwd, {}).trim();
  const parsed = JSON.parse(pretty);
  const min = JSON.stringify(parsed);
  rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
  const result = await mcpCall(cwd, "check_project", {});
  const text = (result.content ?? []).map((c) => c.text ?? "").join("");
  const envelope = Buffer.byteLength(JSON.stringify(result));

  const ids = [
    ...(parsed.remainingIssues ?? parsed.remaining ?? []).map((i) => i.issueId),
    ...(parsed.clusters ?? []).flatMap((c) => c.sampleIssueIds ?? []),
  ].filter(Boolean);
  const lengths = [...new Set(ids.map((i) => i.length))].sort((a, b) => a - b);

  rows.push({
    project,
    issues: parsed.totalIssues,
    payloadMinB: Buffer.byteLength(min),
    claimedPayload: claimed[project].payload,
    payloadDelta: `${Buffer.byteLength(min) - claimed[project].payload} B`,
    envelopeB: envelope,
    claimedEnvelope: claimed[project].envelope,
    envDelta: `${envelope - claimed[project].envelope} B`,
    envRatio: (envelope / Buffer.byteLength(min)).toFixed(2) + "x",
    textTok: tok(text),
    idLengths: lengths.join("/"),
  });
  idReport[project] = { idLengths: lengths, sample: ids[0] ?? null };
}

console.log(`\n=== [${build}] payload + wire vs the numbers PR #54 publishes ===`);
console.table(rows);

// ------------------------------------------- short-id round trip + full-id ----
const labDir = join(root, "projects", "cache-lab");
rmSync(join(labDir, ".signalint"), { recursive: true, force: true });
const checkRes = await mcpCall(labDir, "check_project", {});
const checkParsed = JSON.parse((checkRes.content ?? []).map((c) => c.text ?? "").join(""));
const remaining = checkParsed.remainingIssues ?? checkParsed.remaining ?? [];
const shortId = remaining[0]?.issueId;
let detailByShort = null;
let detailByFull = null;
let fullId = null;
if (shortId !== undefined) {
  detailByShort = JSON.parse((await mcpCall(labDir, "get_issue_detail", { issueId: shortId })).content.map((c) => c.text ?? "").join(""));
  const first = Array.isArray(detailByShort) ? detailByShort[0] : detailByShort;
  if (first?.file && first?.message) {
    fullId = createIssueId(first.file, first.rule, first.line, first.message);
    detailByFull = JSON.parse((await mcpCall(labDir, "get_issue_detail", { issueId: fullId })).content.map((c) => c.text ?? "").join(""));
  }
}
const idDetail = {
  shortId,
  shortIdLength: shortId?.length ?? null,
  shortResolves: detailByShort ? detailByShort.status !== "stale" && !detailByShort.__parseError : false,
  fullId,
  fullResolves: detailByFull ? detailByFull.status !== "stale" && !detailByFull.__parseError : false,
  sameResult: JSON.stringify(detailByShort) === JSON.stringify(detailByFull),
};
console.log(`\n=== [${build}] issue id resolution ===`);
console.log(JSON.stringify(idDetail, null, 2));

writeFileSync(join(resultsDir, `verify-pr54.json`), JSON.stringify({ rows, idDetail }, null, 2));
console.log("\nwritten:", join(resultsDir, "verify-pr54.json"));
