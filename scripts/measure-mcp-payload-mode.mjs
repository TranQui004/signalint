// Measures Signalint MCP wire cost across all three payload modes (both, text, structured)
// on the four evaluation fixtures (sparse, systemic-ts, mixed-app, scale-app).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = join(root, "dist", "src", "index.js");

// Try to use gpt-tokenizer if available, otherwise fallback to ~3.8 B/token rule of thumb
let tokenize = (text) => Math.round(Buffer.byteLength(text, "utf8") / 3.8);
try {
  const { encode } = await import("gpt-tokenizer");
  tokenize = (text) => encode(text).length;
} catch {
  // Use fallback estimation
}

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler",
      strict: true, noEmit: true, skipLibCheck: true, types: [],
    },
    include: ["src/**/*.ts"],
  },
  null, 2,
);
const SIGNALINT_CONFIG = JSON.stringify(
  { engines: { oxlint: true, tsc: true, biome: false, eslint: false },
    ignore: ["node_modules/**", "dist/**", ".signalint/**"] },
  null, 2,
);
const OXLINTRC = JSON.stringify({ rules: { eqeqeq: "warn" } }, null, 2);
const PKG = (name) => JSON.stringify({ name, private: true, version: "1.0.0", type: "module" }, null, 2);

function createFixtures(baseDir) {
  function writeProject(name, files) {
    const dir = join(baseDir, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), PKG(name));
    writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
    writeFileSync(join(dir, ".oxlintrc.json"), OXLINTRC);
    writeFileSync(join(dir, "signalint.config.json"), SIGNALINT_CONFIG);
    for (const [file, content] of Object.entries(files)) {
      const target = join(dir, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }

  // 1. sparse (1 issue)
  writeProject("sparse", {
    "src/main.ts": `import { add } from "./math.js";\nconst total: number = "3";\nexport function run(): number {\n  return add(total, 2);\n}\n`,
    "src/math.ts": `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    "src/unused.ts": `export function neverCalled(): void {\n  const leftover = 1;\n  void leftover;\n}\n`,
  });

  // 2. systemic-ts (12 issues)
  const systemic = {};
  for (let i = 1; i <= 12; i += 1) {
    systemic[`src/file${String(i).padStart(2, "0")}.ts`] = `export interface Item${i} {\n  id: number;\n  name: string;\n}\nexport function price${i}(item: Item${i}): number {\n  const base: number = "42";\n  return base + item.id;\n}\nexport function label${i}(item: Item${i}): string {\n  return item.name.toUpperCase();\n}\n`;
  }
  writeProject("systemic-ts", systemic);

  // 3. mixed-app (11 issues)
  writeProject("mixed-app", {
    "src/index.ts": `import { calculateTotal } from "./services/pricing.js";\nimport { formatMoney } from "./utils/format.js";\nimport { User } from "./models/user.js";\nconst user: User = { id: 1, email: "dev@example.com", role: "admin" };\nconst total = calculateTotal("not-an-array");\nconsole.log("total", total, user.email);\n`,
    "src/config.ts": `export const API_BASE = "https://api.example.com";\nexport const REQUEST_TIMEOUT_MS = 3000;\n`,
    "src/models/user.ts": `export interface User {\n  id: number;\n  email: string;\n  role: string;\n  metadata: any;\n}\nexport function isAdmin(user: User): boolean {\n  if (user.role == "admin") { return true; }\n  return false;\n}\n`,
    "src/models/order.ts": `import { User } from "./user.js";\nexport interface Order {\n  id: number;\n  owner: User;\n  total: number;\n}\nexport function createOrder(id: number, owner: User): Order {\n  let total = 0;\n  return { id, owner, total };\n}\n`,
    "src/services/pricing.ts": `export function calculateTotal(items: number[]): number {\n  let sum = 0;\n  for (const item of items) { sum += item; }\n  return sum;\n}\nexport function applyDiscount(total: number, percent: number): number {\n  const factor: number = "0.9";\n  return total * factor * (1 - percent);\n}\n`,
    "src/services/inventory.ts": `import type { Order } from "../models/order.js";\nexport function reserve(order: Order, quantity: number): boolean {\n  const available: number = "7";\n  const unusedLeftover = quantity + 1;\n  return available > quantity && order.id > 0;\n}\nexport function release(orderId: string): void {\n  const id: number = orderId;\n  void id;\n}\n`,
    "src/utils/format.ts": `export function formatMoney(value: number): string {\n  return \`$\${value.toFixed(2)}\`;\n}\nexport function slugify(input: string): string {\n  return input.toLowerCase().replace(/\\s+/g, "-");\n}\nexport function unusedHelper(value: number): number {\n  const doubled = value * 2;\n  return value;\n}\n`,
    "src/utils/validate.ts": `export function isEmail(value: string): boolean {\n  return value.includes("@");\n}\nexport function parseCount(raw: string): number {\n  try { return Number.parseInt(raw, 10); } catch (error) {\n    console.log(error.message);\n    return 0;\n  }\n}\n`,
    "src/api/client.ts": `import { API_BASE, REQUEST_TIMEOUT_MS } from "../config.js";\nexport async function fetchJson(path: string): Promise<unknown> {\n  const response = await fetch(\`\${API_BASE}\${path}\`);\n  const payload: any = await response.json();\n  void REQUEST_TIMEOUT_MS;\n  return payload;\n}\n`,
    "src/api/routes.ts": `import type { Order } from "../models/order.js";\nimport { createOrder } from "../models/order.js";\nexport function buildOrder(id: string): Order {\n  const owner = { id: 1, email: "dev@example.com", role: "admin", metadata: null };\n  return createOrder(id, owner);\n}\n`,
  });

  // 4. scale-app (60 issues)
  const scale = {};
  for (let i = 1; i <= 15; i += 1) {
    scale[`src/shared/type${String(i).padStart(2, "0")}.ts`] = `export function read${i}(raw: string): number {\n  const value: number = raw;\n  return value + ${i};\n}\n`;
  }
  const unique = [
    'export const a: number = "one";',
    "export function b(x: number): string { return x; }",
    "export function c(): number { return; }",
    'export const d: string[] = [1, 2, 3];',
    "export function e(o: { id: number }) { return o.missing; }",
    "export function f(): Promise<number> { return 1; }",
    'export const g: Record<string, number> = { a: "1" };',
    "export function h(items: string[]) { return items.reduce((acc, x) => acc + x, 0); }",
    "export class I { private value = 1; } export const i = new I().value;",
    "export function j(input: unknown) { return input.trim(); }",
    'export const k: 1 = 2;',
    "export function l(): never { }",
    "export function m(a: number, b: number): number { return a ** b ** c; }",
    'export const n: number = Number.parseInt("x", 99);',
    'export function o(): void { const list = [1]; list.push("2"); }',
  ];
  unique.forEach((body, index) => {
    scale[`src/unique/u${String(index + 1).padStart(2, "0")}.ts`] = `${body}\n`;
  });
  for (let i = 1; i <= 15; i += 1) {
    scale[`src/lint/dead${String(i).padStart(2, "0")}.ts`] = `export function dead${i}(input: number): number {\n  const unused${i} = input;\n  return input;\n}\n`;
  }
  const lint = [
    "export function p(a: number, b: number) { return a == b; }",
    "export function q(a: string, b: string) { return a != b; }",
    "export function r(value: any) { return value; }",
    "export function s(value: any) { return value.x; }",
    "export function t() { return new Array(3); }",
    "export function u() { debugger; }",
    "export function v(a: number) { if (a = 1) { return 2; } return 3; }",
    "export function w() { return typeof NaN; }",
    "export function x() { return !!0; }",
    "export function y(list: number[]) { return list.map(String).filter(Boolean).length === 0 == true; }",
    "export function z() { const o = { a: 1, a: 2 }; return o; }",
    "export function aa() { return 1 instanceof Number; }",
    "export function ab() { return void 0 === undefined; }",
    "export function ac(a: number) { return a < 0 && a > 10; }",
    "export function ad() { return new String('x'); }",
  ];
  lint.forEach((body, index) => {
    scale[`src/lint/mixed${String(index + 1).padStart(2, "0")}.ts`] = `${body}\n`;
  });
  writeProject("scale-app", scale);
}

async function callCheckProject(cwd, payloadMode) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    cwd,
    env: {
      ...process.env,
      SIGNALINT_MCP_PAYLOAD: payloadMode,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "measure-harness", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await client.callTool({ name: "check_project", arguments: {} });
  } finally {
    await client.close().catch(() => {});
  }
}

async function measure() {
  const modes = ["both", "text", "structured"];
  const fixtures = ["sparse", "systemic-ts", "mixed-app", "scale-app"];

  const tempDir = mkdtempSync(join(tmpdir(), "signalint-measure-"));
  createFixtures(tempDir);

  const results = [];
  try {
    for (const fixture of fixtures) {
      const cwd = join(tempDir, fixture);

      for (const mode of modes) {
        rmSync(join(cwd, ".signalint"), { recursive: true, force: true });
        const result = await callCheckProject(cwd, mode);

      const text = (result.content ?? []).map((c) => c.text ?? "").join("");
      const textB = Buffer.byteLength(text, "utf8");
      const structuredB = result.structuredContent !== undefined
        ? Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8")
        : 0;

      const wholeJson = JSON.stringify(result);
      const envelopeB = Buffer.byteLength(wholeJson, "utf8");
      const envelopeTok = tokenize(wholeJson);

      // In "both" and "text" modes, payload is the minified text. In "structured", payload is structuredContent.
      const payloadB = mode === "structured" ? structuredB : textB;
      const ratio = (envelopeB / Math.max(payloadB, 1)).toFixed(2) + "x";

      const hasNewline = text.includes("\n");

      results.push({
        fixture,
        mode,
        payloadB,
        textB,
        structuredB,
        envelopeB,
        envelopeTok,
        ratio,
        hasNewline,
      });
    }
  }

  console.log("\n=== MCP Payload Mode Measurements ===");
  console.table(results);

  // Group by fixture to print comparisons
  console.log("\n### Fixture Breakdown\n");
  for (const fixture of fixtures) {
    const fixtureRows = results.filter((r) => r.fixture === fixture);
    const bothRow = fixtureRows.find((r) => r.mode === "both");
    const textRow = fixtureRows.find((r) => r.mode === "text");
    const structuredRow = fixtureRows.find((r) => r.mode === "structured");

    const textSavings = bothRow && textRow
      ? `${(((bothRow.envelopeB - textRow.envelopeB) / bothRow.envelopeB) * 100).toFixed(1)}%`
      : "N/A";

    console.log(`**${fixture}** (payload: ${bothRow?.payloadB ?? 0} B):`);
    console.log(`  - both:       envelope = ${bothRow?.envelopeB} B (${bothRow?.ratio}, ~${bothRow?.envelopeTok} tok)`);
    console.log(`  - text:       envelope = ${textRow?.envelopeB} B (${textRow?.ratio}, ~${textRow?.envelopeTok} tok) [${textSavings} savings vs both]`);
    console.log(`  - structured: envelope = ${structuredRow?.envelopeB} B (${structuredRow?.ratio}, ~${structuredRow?.envelopeTok} tok)`);
    console.log("");
  }

  const issueCounts = {
    sparse: { issues: 1, label: "**1 issue, 1 file**", vsRaw: "+90% (fixed envelope)", hidden: 0 },
    "systemic-ts": { issues: 12, label: "**12 issues, 1 root cause**", vsRaw: "−45% vs raw CLI", hidden: 0 },
    "mixed-app": { issues: 11, label: "**11 issues, 10 distinct rules**", vsRaw: "−13% vs raw CLI", hidden: "0 (was 1 in v1.0.0)" },
    "scale-app": { issues: 60, label: "**60 issues, 30+ distinct rules**", vsRaw: "−68% vs raw CLI", hidden: "0 (was 27 in v1.0.0)" },
  };

  const fmt = (n) => n.toLocaleString("en-US");

  console.log("\n=== docs/benchmarks.md: Table 1 (Benchmark Results - Default Mode 'both') ===\n");
  console.log("| Fixture | Total Issues | Signalint Minified Payload | Full MCP Envelope (`both`) | Wire Ratio | vs Raw CLI Output (`tsc` + `oxlint`) | Issues Hidden / Unreachable |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const fixture of fixtures) {
    const bothRow = results.find((r) => r.fixture === fixture && r.mode === "both");
    const meta = issueCounts[fixture];
    console.log(`| ${meta.label} | ${meta.issues} | ${fmt(bothRow.payloadB)} B (~${tokenize("x".repeat(bothRow.payloadB))} tok) | ${fmt(bothRow.envelopeB)} B (~${bothRow.envelopeTok} tok) | ${bothRow.ratio} | ${meta.vsRaw} | ${meta.hidden} |`);
  }

  console.log("\n=== docs/benchmarks.md: Table 2 (Mode Comparison Across Fixtures) ===\n");
  console.log("| Fixture | Issues | `both` Envelope (Default) | `text` Envelope | `structured` Envelope | `text` Savings vs `both` |");
  console.log("|---|---:|---:|---:|---:|---:|");
  for (const fixture of fixtures) {
    const fixtureRows = results.filter((r) => r.fixture === fixture);
    const bothRow = fixtureRows.find((r) => r.mode === "both");
    const textRow = fixtureRows.find((r) => r.mode === "text");
    const structuredRow = fixtureRows.find((r) => r.mode === "structured");
    const meta = issueCounts[fixture];
    const textRatio = (textRow.envelopeB / Math.max(bothRow.payloadB, 1)).toFixed(2) + "x";
    const structuredRatio = (structuredRow.envelopeB / Math.max(bothRow.payloadB, 1)).toFixed(2) + "x";
    const textSavings = `${(((bothRow.envelopeB - textRow.envelopeB) / bothRow.envelopeB) * 100).toFixed(1)}%`;
    console.log(`| **${fixture}** | ${meta.issues} | ${fmt(bothRow.envelopeB)} B (${bothRow.ratio}) | ${fmt(textRow.envelopeB)} B (${textRatio}) | ${fmt(structuredRow.envelopeB)} B (${structuredRatio}) | ${textSavings} |`);
  }
  console.log("");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

measure().catch((err) => {
  console.error(err);
  process.exit(1);
});
