import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const paths = process.argv.slice(2);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(packageRoot, "dist/src/index.js")],
  cwd: process.cwd(),
});
const client = new Client({ name: "signalint-readme-check", version: "1.0.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "check_project",
    arguments: { paths: paths.length === 0 ? ["."] : paths },
  });
  const text = result.content.find((entry) => entry.type === "text")?.text;
  if (text === undefined) {
    throw new Error("check_project returned no text response.");
  }
  process.stdout.write(`${text}\n`);
} finally {
  await client.close();
}
