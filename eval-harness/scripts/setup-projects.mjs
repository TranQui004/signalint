// Creates seeded, deterministic broken TypeScript projects used by the evaluation.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectsDir = join(root, "projects");

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

function writeProject(name, files) {
  const dir = join(projectsDir, name);
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

// A. systemic-ts: one root cause repeated across 12 files.
const systemic = {};
for (let i = 1; i <= 12; i += 1) {
  systemic[`src/file${String(i).padStart(2, "0")}.ts`] = `export interface Item${i} {
  id: number;
  name: string;
}

export function price${i}(item: Item${i}): number {
  const base: number = "42";
  return base + item.id;
}

export function label${i}(item: Item${i}): string {
  return item.name.toUpperCase();
}
`;
}
writeProject("systemic-ts", systemic);

// B. mixed-app: small realistic app, lint + type problems.
writeProject("mixed-app", {
  "src/index.ts": `import { calculateTotal } from "./services/pricing.js";
import { formatMoney } from "./utils/format.js";
import { User } from "./models/user.js";

const user: User = { id: 1, email: "dev@example.com", role: "admin" };

const total = calculateTotal("not-an-array");
console.log("total", total, user.email);
`,
  "src/config.ts": `export const API_BASE = "https://api.example.com";
export const REQUEST_TIMEOUT_MS = 3000;
`,
  "src/models/user.ts": `export interface User {
  id: number;
  email: string;
  role: string;
  metadata: any;
}

export function isAdmin(user: User): boolean {
  if (user.role == "admin") {
    return true;
  }
  return false;
}
`,
  "src/models/order.ts": `import { User } from "./user.js";

export interface Order {
  id: number;
  owner: User;
  total: number;
}

export function createOrder(id: number, owner: User): Order {
  let total = 0;
  return { id, owner, total };
}
`,
  "src/services/pricing.ts": `export function calculateTotal(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}

export function applyDiscount(total: number, percent: number): number {
  const factor: number = "0.9";
  return total * factor * (1 - percent);
}
`,
  "src/services/inventory.ts": `import type { Order } from "../models/order.js";

export function reserve(order: Order, quantity: number): boolean {
  const available: number = "7";
  const unusedLeftover = quantity + 1;
  return available > quantity && order.id > 0;
}

export function release(orderId: string): void {
  const id: number = orderId;
  void id;
}
`,
  "src/utils/format.ts": `export function formatMoney(value: number): string {
  return \`$\${value.toFixed(2)}\`;
}

export function slugify(input: string): string {
  return input.toLowerCase().replace(/\\s+/g, "-");
}

export function unusedHelper(value: number): number {
  const doubled = value * 2;
  return value;
}
`,
  "src/utils/validate.ts": `export function isEmail(value: string): boolean {
  return value.includes("@");
}

export function parseCount(raw: string): number {
  try {
    return Number.parseInt(raw, 10);
  } catch (error) {
    console.log(error.message);
    return 0;
  }
}
`,
  "src/api/client.ts": `import { API_BASE, REQUEST_TIMEOUT_MS } from "../config.js";

export async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(\`\${API_BASE}\${path}\`);
  const payload: any = await response.json();
  void REQUEST_TIMEOUT_MS;
  return payload;
}
`,
  "src/api/routes.ts": `import type { Order } from "../models/order.js";
import { createOrder } from "../models/order.js";

export function buildOrder(id: string): Order {
  const owner = { id: 1, email: "dev@example.com", role: "admin", metadata: null };
  return createOrder(id, owner);
}
`,
});

// C. sparse: tiny project, 1 real issue.
writeProject("sparse", {
  "src/main.ts": `import { add } from "./math.js";

const total: number = "3";
export function run(): number {
  return add(total, 2);
}
`,
  "src/math.ts": `export function add(a: number, b: number): number {
  return a + b;
}
`,
  "src/unused.ts": `export function neverCalled(): void {
  const leftover = 1;
  void leftover;
}
`,
});

// D. scale-app: ~60 issues, 15 systemic type errors + 15 unique type errors
//    + 15 repeated lint issues + 15 distinct lint issues.
const scale = {};
for (let i = 1; i <= 15; i += 1) {
  scale[`src/shared/type${String(i).padStart(2, "0")}.ts`] =
    `export function read${i}(raw: string): number {\n  const value: number = raw;\n  return value + ${i};\n}\n`;
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
  scale[`src/lint/dead${String(i).padStart(2, "0")}.ts`] =
    `export function dead${i}(input: number): number {\n  const unused${i} = input;\n  return input;\n}\n`;
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

console.log("projects written to", projectsDir);
