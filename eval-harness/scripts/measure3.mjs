// Round 3: compare the published 1.0.0 CLI against the PR #52 CLI on identical
// fixtures, and verify the new payload invariants.
// Usage: node scripts/measure3.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectsDir = join(root, "projects");
const resultsDir = join(root, "results");
const bin = (name) => join(root, "node_modules", ".bin", name);

const targets = {
  "v1.0.0": join(root, "node_modules", "signalint-mcp", "dist", "src", "cli.js"),
  "pr52": join(root, "builds", "pr52", "dist", "src", "cli.js"),
};

const projects = ["sparse", "systemic-ts", "mixed-app", "scale-app"];
mkdirSync(resultsDir, { recursive: true });

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    return error.stdout ?? "";
  }
}
const bytes = (t) => Buffer.byteLength(t, "utf8");
const tokens = (t) => encode(t).length;

const rows = [];
for (const project of projects) {
  const cwd = join(projectsDir, project);

  // one shared raw baseline per fixture (identical for both CLIs)
  const tscPlain = run(bin("tsc"), ["--noEmit", "--pretty", "false"], cwd).trim();
  const oxAgent = run(bin("oxlint"), ["--format", "agent"], cwd).trim();
  const raw = `${tscPlain}\n${oxAgent}\n`;

  for (const [label, cli] of Object.entries(targets)) {
    rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
    const out = run(process.execPath, [cli, "check", "."], cwd).trim();
    let payload;
    try {
      payload = JSON.parse(out);
    } catch {
      rows.push({ project, cli: label, error: out.slice(0, 200) });
      continue;
    }
    const clusters = payload.clusters ?? [];
    const remaining = payload.remainingIssues ?? [];
    const clusterIssues = clusters.reduce((s, c) => s + (c.issueCount ?? 0), 0);
    const visible = clusterIssues + remaining.length;
    rows.push({
      project,
      cli: label,
      schemaVersion: payload.schemaVersion,
      totalIssues: payload.totalIssues,
      clusters: clusters.length,
      remaining: remaining.length,
      omitted: payload.omittedIssueCount ?? 0,
      truncated: payload.truncated,
      visible,
      unreachable: (payload.totalIssues ?? 0) - visible - (payload.omittedIssueCount ?? 0),
      invariantOk: (payload.totalIssues ?? 0) === clusterIssues + remaining.length + (payload.omittedIssueCount ?? 0),
      payloadBytes: bytes(out),
      payloadTokens: tokens(out),
      rawBytes: bytes(raw),
      rawTokens: tokens(raw),
      vsRawBytes: (bytes(out) / bytes(raw) - 1) * 100,
      vsRawTokens: (tokens(out) / tokens(raw) - 1) * 100,
    });
  }
}

console.table(
  rows.map((r) => ({
    project: r.project,
    cli: r.cli,
    schema: r.schemaVersion,
    total: r.totalIssues,
    clusters: r.clusters,
    remaining: r.remaining,
    omitted: r.omitted,
    unreachable: r.unreachable,
    invariant: r.invariantOk,
    "payload B": r.payloadBytes,
    "raw B": r.rawBytes,
    "vs raw %": `${r.vsRawBytes.toFixed(0)}%`,
    "payload tok": r.payloadTokens,
    "raw tok": r.rawTokens,
  })),
);

writeFileSync(join(resultsDir, "round3-pr52.json"), JSON.stringify(rows, null, 2));
console.log("written:", join(resultsDir, "round3-pr52.json"));
