// Round 4a: measures what an agent ACTUALLY receives over MCP (JSON-RPC), not the CLI.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectsDir = join(root, "projects");
const resultsDir = join(root, "results");
mkdirSync(resultsDir, { recursive: true });

const servers = {
  "v1.0.0": join(root, "node_modules", "signalint-mcp", "dist", "src", "index.js"),
  "pr52": join(root, "builds", "pr52", "dist", "src", "index.js"),
  "pr52+compact": join(root, "builds", "pr52", "dist", "src", "index.js"),
};

const tok = (t) => encode(t).length;

async function callTool(entry, cwd, compact) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd,
    env: { ...process.env, SIGNALINT_COMPACT: compact ? "1" : "0" },
    stderr: "pipe",
  });
  const client = new Client({ name: "eval-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "check_project", arguments: {} });
    return result;
  } finally {
    await client.close().catch(() => {});
  }
}

const rows = [];
for (const project of ["sparse", "systemic-ts", "mixed-app", "scale-app"]) {
  const cwd = join(projectsDir, project);
  for (const [name, entry] of Object.entries(servers)) {
    rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
    const result = await callTool(entry, cwd, name.endsWith("+compact"));
    const text = (result.content ?? []).map((c) => c.text ?? "").join("");
    const whole = JSON.stringify(result);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep null */
    }
    rows.push({
      project,
      server: name,
      issues: parsed?.totalIssues ?? parsed?.total ?? null,
      schema: parsed?.schemaVersion ?? parsed?.v ?? "?",
      textB: Buffer.byteLength(text),
      textTok: tok(text),
      envelopeB: Buffer.byteLength(whole),
      // Overhead of wrapping the payload in the MCP JSON-RPC text envelope:
      wrapOverhead: `${(Buffer.byteLength(whole) / Math.max(Buffer.byteLength(text), 1)).toFixed(2)}x`,
    });
  }
}

console.table(rows);
writeFileSync(join(resultsDir, "round4-mcp.json"), JSON.stringify(rows, null, 2));
console.log("written:", join(resultsDir, "round4-mcp.json"));
