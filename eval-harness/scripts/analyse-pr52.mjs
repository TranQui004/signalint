// Reconciles byte-counting methodologies and quantifies the cost of issueIds.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectsDir = join(root, "projects");
const resultsDir = join(root, "results");
const bin = (name) => join(root, "node_modules", ".bin", name);
const cli = join(root, "builds", "pr52", "dist", "src", "cli.js");
mkdirSync(resultsDir, { recursive: true });

const run = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    return e.stdout ?? "";
  }
};
const tok = (t) => encode(t).length;

/** Counts characters spent on 64-char hex issue ids. */
function idCost(value) {
  let count = 0;
  let chars = 0;
  const walk = (node) => {
    if (typeof node === "string") {
      if (/^[0-9a-f]{64}$/.test(node)) {
        count += 1;
        chars += node.length;
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") return Object.values(node).forEach(walk);
  };
  walk(value);
  return { count, chars };
}

const rows = [];
for (const project of ["sparse", "systemic-ts", "mixed-app", "scale-app"]) {
  const cwd = join(projectsDir, project);
  rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
  const pretty = run(process.execPath, [cli, "check", "."], cwd).trim();
  const payload = JSON.parse(pretty);
  const minified = JSON.stringify(payload);
  const shortened = JSON.stringify(payload).replace(/[0-9a-f]{64}/g, (m) => m.slice(0, 12));

  const tscPlain = run(bin("tsc"), ["--noEmit", "--pretty", "false"], cwd).trim();
  const oxAgent = run(bin("oxlint"), ["--format", "agent"], cwd).trim();
  const raw = `${tscPlain}\n${oxAgent}\n`;
  const ids = idCost(payload);

  rows.push({
    project,
    issues: payload.totalIssues,
    prettyB: Buffer.byteLength(pretty),
    minB: Buffer.byteLength(minified),
    shortIdB: Buffer.byteLength(shortened),
    prettyTok: tok(pretty),
    minTok: tok(minified),
    shortIdTok: tok(shortened),
    rawB: Buffer.byteLength(raw),
    rawTok: tok(raw),
    idCount: ids.count,
    idChars: ids.chars,
    idShare: `${((ids.chars / Buffer.byteLength(minified)) * 100).toFixed(1)}%`,
    minVsRaw: `${((Buffer.byteLength(minified) / Buffer.byteLength(raw) - 1) * 100).toFixed(0)}%`,
    tokVsRaw: `${((tok(minified) / tok(raw) - 1) * 100).toFixed(0)}%`,
    shortTokVsRaw: `${((tok(shortened) / tok(raw) - 1) * 100).toFixed(0)}%`,
  });
}

console.table(
  rows.map((r) => ({
    project: r.project,
    issues: r.issues,
    "pretty B": r.prettyB,
    "min B": r.minB,
    "min vs raw": r.minVsRaw,
    "min tok": r.minTok,
    "raw tok": r.rawTok,
    "tok vs raw": r.tokVsRaw,
    "ids": r.idCount,
    "id % of payload": r.idShare,
    "shortId B": r.shortIdB,
    "shortId tok vs raw": r.shortTokVsRaw,
  })),
);
writeFileSync(join(resultsDir, "pr52-analysis.json"), JSON.stringify(rows, null, 2));
console.log("written:", join(resultsDir, "pr52-analysis.json"));
