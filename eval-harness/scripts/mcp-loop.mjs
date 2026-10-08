// Round 4d: does loop detection actually fire on fix -> reappear cycles?
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lab = join(root, "projects", "loop-lab");
rmSync(lab, { recursive: true, force: true });
mkdirSync(join(lab, "src"), { recursive: true });
writeFileSync(join(lab, "package.json"), JSON.stringify({ name: "loop-lab", private: true, type: "module" }, null, 2));
writeFileSync(
  join(lab, "tsconfig.json"),
  JSON.stringify(
    { compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext", moduleResolution: "bundler", types: [] }, include: ["src/**/*.ts"] },
    null,
    2,
  ),
);
writeFileSync(join(lab, ".oxlintrc.json"), JSON.stringify({ rules: { eqeqeq: "warn" } }, null, 2));
writeFileSync(join(lab, "signalint.config.json"), JSON.stringify({ engines: { oxlint: true, tsc: true, biome: false, eslint: false } }, null, 2));

const target = join(lab, "src", "flaky.ts");
const BROKEN = 'export const n: number = "x";\n';
const FIXED = "export const n: number = 1;\n";
writeFileSync(target, BROKEN);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "builds", "pr52", "dist", "src", "index.js")],
  cwd: lab,
  env: { ...process.env },
  stderr: "pipe",
});
const client = new Client({ name: "eval-harness", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const parse = (r) => {
  const text = (r.content ?? []).map((c) => c.text ?? "").join("");
  try {
    return JSON.parse(text);
  } catch {
    return { __parseError: text.slice(0, 200) };
  }
};
const check = async () => parse(await client.callTool({ name: "check_project", arguments: {} }));
const loopStatus = async () => parse(await client.callTool({ name: "get_loop_status", arguments: {} }));

const rows = [];
for (let cycle = 1; cycle <= 4; cycle += 1) {
  writeFileSync(target, BROKEN);
  const withIssue = await check();
  writeFileSync(target, FIXED);
  const fixed = await check();
  const status = await loopStatus();
  rows.push({
    cycle,
    issuesWhenBroken: withIssue.totalIssues,
    loopWarningInPayload: withIssue.loopWarning ? JSON.stringify(withIssue.loopWarning).slice(0, 60) : "null",
    issuesWhenFixed: fixed.totalIssues,
    looping: status.looping,
    signatures: JSON.stringify(status.signatures),
    fileChurning: status.fileChurning,
  });
}
console.table(
  rows.map((r) => ({
    cycle: r.cycle,
    broken: r.issuesWhenBroken,
    fixed: r.issuesWhenFixed,
    looping: r.looping,
    signatures: r.signatures.slice(0, 70),
    payloadWarning: r.loopWarningInPayload,
  })),
);
await client.close().catch(() => {});
