import { spawn, execSync } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

async function main() {
  const rootDir = process.cwd();
  const packageJsonPath = resolve(rootDir, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const expectedVersion = packageJson.version;

  // 1. Validate root package name is exactly 'signalint-mcp'
  if (packageJson.name !== "signalint-mcp") {
    throw new Error(`[smoke-tarball] Expected package name 'signalint-mcp', got '${packageJson.name}'`);
  }
  console.log(`[smoke-tarball] Verifying package '${packageJson.name}' version: ${expectedVersion}`);

  // 2. Validate release tag matches package.json version if a release tag is provided
  const releaseTag =
    process.argv.slice(2).find((arg) => arg.startsWith("v")) ||
    process.env.RELEASE_TAG ||
    (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined) ||
    process.env.INPUT_TAG;

  if (releaseTag) {
    const cleanTag = releaseTag.replace(/^v/, "");
    if (cleanTag !== expectedVersion) {
      throw new Error(
        `[smoke-tarball] Version mismatch: package.json version '${expectedVersion}' does not match release tag '${releaseTag}'`,
      );
    }
    console.log(`[smoke-tarball] Release tag matches package.json version: ${releaseTag}`);
  } else {
    console.log(`[smoke-tarball] No release tag supplied; proceeding with package.json version ${expectedVersion}`);
  }

  // Create disposable temporary directory
  const tempDir = await mkdtemp(resolve(tmpdir(), "signalint-tarball-smoke-"));
  console.log(`[smoke-tarball] Created disposable temp directory: ${tempDir}`);

  try {
    // 3. Obtain or pack tarball
    const explicitTarballArg = process.argv.slice(2).find((arg) => arg.endsWith(".tgz"));
    let tarballPath;

    if (explicitTarballArg) {
      const resolvedExplicit = resolve(rootDir, explicitTarballArg);
      if (!existsSync(resolvedExplicit)) {
        throw new Error(`[smoke-tarball] Specified tarball does not exist: ${resolvedExplicit}`);
      }
      console.log(`[smoke-tarball] Using existing tarball: ${resolvedExplicit}`);
      const destPath = join(tempDir, basename(resolvedExplicit));
      copyFileSync(resolvedExplicit, destPath);
      tarballPath = destPath;
    } else {
      console.log("[smoke-tarball] Running npm pack...");
      const packCmd = `npm pack --pack-destination "${tempDir}"`;
      execSync(packCmd, { cwd: rootDir, stdio: "inherit" });

      const files = readdirSync(tempDir);
      const tarballName = files.find((f) => f.endsWith(".tgz"));
      if (!tarballName) {
        throw new Error(`[smoke-tarball] No .tgz tarball found in ${tempDir}`);
      }
      tarballPath = join(tempDir, tarballName);
      console.log(`[smoke-tarball] Found generated tarball: ${tarballPath}`);
    }

    // Create a minimal package.json in tempDir so npm install treats it as a local project
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "signalint-smoke-test", private: true }, null, 2),
      "utf8",
    );

    // 4. Install tarball into temp directory
    console.log("[smoke-tarball] Installing tarball in disposable directory...");
    execSync(`npm install --no-package-lock "${tarballPath}"`, {
      cwd: tempDir,
      stdio: "inherit",
    });

    // Validate installed package identity
    const installedPkgJsonPath = join(tempDir, "node_modules", "signalint-mcp", "package.json");
    if (!existsSync(installedPkgJsonPath)) {
      throw new Error(`[smoke-tarball] Installed package.json not found at ${installedPkgJsonPath}`);
    }
    const installedPkgJson = JSON.parse(readFileSync(installedPkgJsonPath, "utf8"));
    if (installedPkgJson.name !== "signalint-mcp") {
      throw new Error(`[smoke-tarball] Installed package name mismatch: expected 'signalint-mcp', got '${installedPkgJson.name}'`);
    }
    if (installedPkgJson.version !== expectedVersion) {
      throw new Error(`[smoke-tarball] Installed package version mismatch: expected '${expectedVersion}', got '${installedPkgJson.version}'`);
    }
    console.log(`[smoke-tarball] Installed package identity verified: ${installedPkgJson.name}@${installedPkgJson.version}`);

    const isWindows = process.platform === "win32";
    const binDir = join(tempDir, "node_modules", ".bin");
    const signalintCmd = join(binDir, "signalint.cmd");
    const signalintSh = join(binDir, "signalint");
    const cliCandidatePaths = [
      join(tempDir, "node_modules", "signalint-mcp", "dist", "src", "cli.js"),
      join(tempDir, "node_modules", "signalint-mcp", "dist", "cli.js"),
    ];
    const cliEntrypoint = cliCandidatePaths.find((p) => existsSync(p));
    if (!cliEntrypoint) {
      throw new Error(`[smoke-tarball] Executable bin entrypoint missing in installed package (checked dist/src/cli.js and dist/cli.js)`);
    }

    // Verify executable permissions
    if (!isWindows) {
      try {
        accessSync(cliEntrypoint, constants.X_OK);
      } catch {
        const stat = statSync(cliEntrypoint);
        if ((stat.mode & 0o111) === 0) {
          throw new Error(`[smoke-tarball] Executable bin '${cliEntrypoint}' lacks executable permissions (mode: ${stat.mode.toString(8)})`);
        }
      }
      if (existsSync(signalintSh)) {
        try {
          accessSync(signalintSh, constants.X_OK);
        } catch {
          const stat = statSync(signalintSh);
          if ((stat.mode & 0o111) === 0) {
            throw new Error(`[smoke-tarball] Bin wrapper '${signalintSh}' lacks executable permissions`);
          }
        }
      }
      console.log(`[smoke-tarball] Executable bin permissions verified for ${cliEntrypoint}`);
    } else {
      console.log(`[smoke-tarball] Executable bin verified: ${cliEntrypoint}`);
    }

    const mcpCandidatePaths = [
      join(tempDir, "node_modules", "signalint-mcp", "dist", "src", "index.js"),
      join(tempDir, "node_modules", "signalint-mcp", "dist", "index.js"),
    ];
    const mcpEntrypoint = mcpCandidatePaths.find((p) => existsSync(p));
    if (!mcpEntrypoint) {
      throw new Error(`[smoke-tarball] MCP entrypoint missing in installed package`);
    }

    function runCli(commandArgs) {
      if (isWindows && existsSync(signalintCmd)) {
        return execSync(`"${signalintCmd}" ${commandArgs}`, { cwd: tempDir, encoding: "utf8" });
      }
      if (existsSync(signalintSh)) {
        return execSync(`"${signalintSh}" ${commandArgs}`, { cwd: tempDir, encoding: "utf8" });
      }
      return execSync(`node "${cliEntrypoint}" ${commandArgs}`, { cwd: tempDir, encoding: "utf8" });
    }

    // 5. Run: signalint --version
    console.log("[smoke-tarball] Checking signalint --version...");
    const versionOutput = runCli("--version").trim();
    if (versionOutput !== expectedVersion) {
      throw new Error(
        `[smoke-tarball] Version mismatch: expected '${expectedVersion}', received '${versionOutput}'`,
      );
    }
    console.log(`[smoke-tarball] --version verified: ${versionOutput}`);

    // 6. Run: signalint doctor
    console.log("[smoke-tarball] Checking signalint doctor...");
    writeFileSync(join(tempDir, "signalint.config.json"), "{}\n", "utf8");
    const doctorOutput = runCli("doctor");
    if (!doctorOutput.includes("=== Signalint Doctor ===") || !doctorOutput.includes("PASSED")) {
      throw new Error(`[smoke-tarball] Unexpected doctor report: ${doctorOutput}`);
    }
    console.log("[smoke-tarball] doctor verified: PASSED (exited 0)");

    // 7. Stdio smoke test
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
