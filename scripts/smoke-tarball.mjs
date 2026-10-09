import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function main() {
  const rootDir = process.cwd();
  const packageJsonPath = resolve(rootDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const expectedVersion = packageJson.version;

  console.log(`[smoke-tarball] Verifying package version: ${expectedVersion}`);

  // Create disposable temporary directory
  const tempDir = await mkdtemp(resolve(tmpdir(), "signalint-tarball-smoke-"));
  console.log(`[smoke-tarball] Created disposable temp directory: ${tempDir}`);

  try {
    // 1. Pack tarball into temp directory
    console.log("[smoke-tarball] Running npm pack...");
    const packCmd = `npm pack --pack-destination "${tempDir}"`;
    execSync(packCmd, { cwd: rootDir, stdio: "inherit" });

    const files = readdirSync(tempDir);
    const tarballName = files.find((f) => f.endsWith(".tgz"));
    if (!tarballName) {
      throw new Error(`[smoke-tarball] No .tgz tarball found in ${tempDir}`);
    }
    const tarballPath = join(tempDir, tarballName);
    console.log(`[smoke-tarball] Found generated tarball: ${tarballPath}`);

    // Create a minimal package.json in tempDir so npm install treats it as a local project
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "signalint-smoke-test", private: true }, null, 2),
      "utf8",
    );

    // 2. Install tarball into temp directory
    console.log("[smoke-tarball] Installing tarball in disposable directory...");
    execSync(`npm install --no-package-lock "${tarballPath}"`, {
      cwd: tempDir,
      stdio: "inherit",
    });

    const isWindows = process.platform === "win32";
    const binDir = join(tempDir, "node_modules", ".bin");
    const signalintCmd = join(binDir, "signalint.cmd");
    const signalintSh = join(binDir, "signalint");
    const cliEntrypoint = join(tempDir, "node_modules", "signalint-mcp", "dist", "src", "cli.js");
    const mcpEntrypoint = join(tempDir, "node_modules", "signalint-mcp", "dist", "src", "index.js");

    function runCli(commandArgs) {
      if (isWindows && existsSync(signalintCmd)) {
        return execSync(`"${signalintCmd}" ${commandArgs}`, { cwd: tempDir, encoding: "utf8" });
      }
      if (existsSync(signalintSh)) {
        return execSync(`"${signalintSh}" ${commandArgs}`, { cwd: tempDir, encoding: "utf8" });
      }
      return execSync(`node "${cliEntrypoint}" ${commandArgs}`, { cwd: tempDir, encoding: "utf8" });
    }

    // 3. Run: signalint --version
    console.log("[smoke-tarball] Checking signalint --version...");
    const versionOutput = runCli("--version").trim();
    if (versionOutput !== expectedVersion) {
      throw new Error(
        `[smoke-tarball] Version mismatch: expected '${expectedVersion}', received '${versionOutput}'`,
      );
    }
    console.log(`[smoke-tarball] --version verified: ${versionOutput}`);

    // 4. Run: signalint doctor
    console.log("[smoke-tarball] Checking signalint doctor...");
    writeFileSync(join(tempDir, "signalint.config.json"), "{}\n", "utf8");
    const doctorOutput = runCli("doctor");
    if (!doctorOutput.includes("=== Signalint Doctor ===") || !doctorOutput.includes("PASSED")) {
      throw new Error(`[smoke-tarball] Unexpected doctor report: ${doctorOutput}`);
    }
    console.log("[smoke-tarball] doctor verified: PASSED (exited 0)");

    // 5. Stdio smoke test
    console.log("[smoke-tarball] Running Stdio MCP handshake & ping smoke test...");
    await runStdioSmokeTest(mcpEntrypoint, tempDir, expectedVersion);
    console.log("[smoke-tarball] Stdio MCP smoke test passed successfully!");
  } finally {
    console.log(`[smoke-tarball] Cleaning up temp directory: ${tempDir}`);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runStdioSmokeTest(entrypoint, cwd, expectedVersion) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [entrypoint], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const receivedMessages = [];
    const pendingRequests = new Map();

    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("[smoke-tarball] Stdio smoke test timed out after 15s"));
    }, 15000);

    child.stderr.on("data", (chunk) => {
      // Optional stderr logs from server startup
      process.stderr.write(`[server-stderr] ${chunk.toString("utf8")}`);
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed.id !== "undefined") {
            const resolver = pendingRequests.get(parsed.id);
            if (resolver) {
              pendingRequests.delete(parsed.id);
              resolver(parsed);
            }
          }
          receivedMessages.push(parsed);
        } catch {
          // Non-JSON stdout lines ignored
        }
      }
    });

    function sendRequest(id, method, params = {}) {
      return new Promise((res) => {
        pendingRequests.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    }

    function sendNotification(method, params = {}) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    }

    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectPromise(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0 && code !== 143) {
        rejectPromise(new Error(`[smoke-tarball] Server process exited unexpectedly with code ${code}`));
      }
    });

    (async () => {
      try {
        // Send initialize
        const initResponse = await sendRequest(1, "initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoke-client", version: "1.0.0" },
        });

        if (!initResponse.result || !initResponse.result.serverInfo) {
          throw new Error(`[smoke-tarball] Malformed initialize response: ${JSON.stringify(initResponse)}`);
        }

        const serverVersion = initResponse.result.serverInfo.version;
        if (serverVersion !== expectedVersion) {
          throw new Error(
            `[smoke-tarball] serverInfo.version mismatch: expected '${expectedVersion}', got '${serverVersion}'`,
          );
        }
        console.log(`[smoke-tarball] serverInfo.version matches: ${serverVersion}`);

        // Acknowledge initialized
        sendNotification("notifications/initialized");

        // Send ping tool call
        const pingResponse = await sendRequest(2, "tools/call", {
          name: "ping",
          arguments: {},
        });

        if (!pingResponse.result) {
          throw new Error(`[smoke-tarball] Malformed ping response: ${JSON.stringify(pingResponse)}`);
        }

        const hasPongContent =
          Array.isArray(pingResponse.result.content) &&
          pingResponse.result.content.some((c) => c.text === "pong");
        const hasPongStructured =
          pingResponse.result.structuredContent &&
          pingResponse.result.structuredContent.pong === true;

        if (!hasPongContent && !hasPongStructured) {
          throw new Error(`[smoke-tarball] Ping did not return pong: ${JSON.stringify(pingResponse.result)}`);
        }
        console.log("[smoke-tarball] tools/call ping verified: received pong");

        clearTimeout(timeout);
        child.kill();
        resolvePromise();
      } catch (err) {
        clearTimeout(timeout);
        child.kill();
        rejectPromise(err);
      }
    })();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
