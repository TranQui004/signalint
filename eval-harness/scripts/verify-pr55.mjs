// Verifies PR #55: three MCP payload modes, defaults, precedence, doctor, tools/list.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "builds", "pr55", "dist", "src");
const resultsDir = join(root, "results");
mkdirSync(resultsDir, { recursive: true });
const tok = (t) => encode(t).length;

async function session(cwd, env) {
  const transport = new StdioClientTransport({
    command: process.env.NODE_BIN || process.execPath,
    args: [join(dist, "index.js")],
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stderr: "pipe",
  });
  const client = new Client({ name: "eval-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    call: (tool, args) => client.callTool({ name: tool, arguments: args }),
    close: () => client.close().catch(() => {}),
  };
}

const shapes = async (cwd, env) => {
  const s = await session(cwd, env);
  const tools = (await s.client.listTools()).tools ?? [];
  const r = await s.call("check_project", {});
  await s.close();
  const text = (r.content ?? []).map((c) => c.text ?? "").join("");
  return {
    textB: Buffer.byteLength(text),
    structuredB: r.structuredContent !== undefined ? Buffer.byteLength(JSON.stringify(r.structuredContent)) : 0,
    envelopeB: Buffer.byteLength(JSON.stringify(r)),
    ratio: (Buffer.byteLength(JSON.stringify(r)) / Math.max(Buffer.byteLength(text) || Buffer.byteLength(JSON.stringify(r.structuredContent ?? {})), 1)).toFixed(2),
    textNewlines: text.includes("\n"),
    hasText: (r.content ?? []).length > 0,
    hasStructured: r.structuredContent !== undefined,
    outputSchema: tools.map((t) => (t.outputSchema !== undefined ? t.name : null)).filter(Boolean).join(",") || "none",
    textTok: tok(text),
    textPreview: text.slice(0, 60),
  };
};

const rows = [];
for (const project of ["sparse", "systemic-ts", "mixed-app", "scale-app"]) {
  const cwd = join(root, "projects", project);
  for (const mode of ["both", "text", "structured"]) {
    rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
    const s = await shapes(cwd, { SIGNALINT_MCP_PAYLOAD: mode });
    rows.push({
      project,
      mode,
      textB: s.textB,
      structuredB: s.structuredB,
      envelopeB: s.envelopeB,
      ratio: s.ratio + "x",
      hasText: s.hasText,
      hasStructured: s.hasStructured,
      newlines: s.textNewlines,
      tok: s.textTok,
    });
  }
}
console.log("\n=== [pr55] three payload modes, measured over real MCP stdio ===");
console.table(rows);

const summary = [];
for (const project of ["sparse", "systemic-ts", "mixed-app", "scale-app"]) {
  const r = rows.filter((x) => x.project === project);
  const both = r.find((x) => x.mode === "both");
  const text = r.find((x) => x.mode === "text");
  const struct = r.find((x) => x.mode === "structured");
  summary.push({
    project,
    bothB: both.envelopeB,
    textB: text.envelopeB,
    textSaving: `${(100 - (text.envelopeB / both.envelopeB) * 100).toFixed(1)}%`,
    structuredB: struct.envelopeB,
    structuredSaving: `${(100 - (struct.envelopeB / both.envelopeB) * 100).toFixed(1)}%`,
  });
}
console.log("\n=== savings vs default 'both' ===");
console.table(summary);

// ------------------------------------------------- defaults & precedence ----
const cwd = join(root, "projects", "mixed-app");
const cfgPath = join(cwd, "signalint.config.json");
const originalCfg = readFileSync(cfgPath, "utf8");

const noEnv = await shapes(cwd, {});
console.log("\n=== default (no env, no config key) ===");
console.log({ hasText: noEnv.hasText, hasStructured: noEnv.hasStructured, envelopeB: noEnv.envelopeB, outputSchema: noEnv.outputSchema });

writeFileSync(cfgPath, JSON.stringify({ engines: { oxlint: true, tsc: true, biome: false, eslint: false }, mcpPayload: "text" }, null, 2));
const cfgOnly = await shapes(cwd, {});
console.log("\n=== config mcpPayload=text, no env ===");
console.log({ hasText: cfgOnly.hasText, hasStructured: cfgOnly.hasStructured, envelopeB: cfgOnly.envelopeB });

const envWins = await shapes(cwd, { SIGNALINT_MCP_PAYLOAD: "structured" });
console.log("\n=== config=text + env=structured (env must win) ===");
console.log({ hasText: envWins.hasText, hasStructured: envWins.hasStructured, envelopeB: envWins.envelopeB, preview: envWins.textPreview });
writeFileSync(cfgPath, originalCfg);

// ------------------------------------------------------------- doctor -------
try {
  const out = execFileSync(process.execPath, [join(dist, "cli.js"), "doctor"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, SIGNALINT_MCP_PAYLOAD: "text" },
  });
  console.log("\n=== doctor (env text) ===");
  console.log(out.split("\n").filter((l) => /payload/i.test(l)).join("\n") || "(no payload-mode line)");
} catch (e) {
  console.log("\n=== doctor failed:", (e.stdout ?? "").slice(0, 300));
}

// ------------------------------------------------ all five tools in text mode --
const s = await session(cwd, { SIGNALINT_MCP_PAYLOAD: "text" });
const five = {};
five.ping = await s.call("ping", {});
five.check_project = await s.call("check_project", {});
five.check_files = await s.call("check_files", { files: ["src/a.ts"] }).catch(() => null);
five.get_loop_status = await s.call("get_loop_status", {});
const detail = await s.call("check_project", {});
const parsed = JSON.parse((detail.content ?? []).map((c) => c.text ?? "").join(""));
const someId = (parsed.remainingIssues ?? parsed.remaining ?? [])[0]?.issueId;
five.get_issue_detail = someId ? await s.call("get_issue_detail", { issueId: someId }) : null;
console.log("\n=== text mode: every tool — channels + newlines ===");
console.table(
  Object.entries(five).map(([name, r]) => ({
    tool: name,
    hasText: r ? (r.content ?? []).length > 0 : null,
    hasStructured: r ? r.structuredContent !== undefined : null,
    newlines: r ? (r.content ?? []).map((c) => c.text ?? "").join("").includes("\n") : null,
  })),
);
await s.close();

writeFileSync(join(resultsDir, "verify-pr55.json"), JSON.stringify({ rows, summary }, null, 2));
console.log("\nwritten:", join(resultsDir, "verify-pr55.json"));
