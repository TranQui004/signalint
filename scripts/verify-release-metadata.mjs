import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAndValidateReleaseTag } from "./verify-release-tag.mjs";

/**
 * Extracts inputs.version.default from action.yml content.
 */
export function extractActionVersion(actionYmlContent) {
  const match = actionYmlContent.match(/inputs:[\s\S]*?version:[\s\S]*?default:\s*["']?([^"'\s\r\n]+)["']?/);
  return match ? match[1] : undefined;
}

/**
 * Validates package.json, server.json, action.yml, and release tag consistency.
 */
export function verifyReleaseMetadata({
  rootDir = process.cwd(),
  env = process.env,
} = {}) {
  // 1. Verify package.json
  const packageJsonPath = resolve(rootDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    throw new Error(`package.json not found at ${packageJsonPath}`);
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "signalint-mcp") {
    throw new Error(`package.json name must be 'signalint-mcp', got '${packageJson.name}'.`);
  }
  const packageVersion = packageJson.version;
  if (!packageVersion || !/^\d+\.\d+\.\d+.*$/.test(packageVersion)) {
    throw new Error(`Invalid package.json version '${packageVersion}'.`);
  }

  // 2. Verify server.json
  const serverJsonPath = resolve(rootDir, "server.json");
  if (!existsSync(serverJsonPath)) {
    throw new Error(`server.json not found at ${serverJsonPath}`);
  }
  const serverJson = JSON.parse(readFileSync(serverJsonPath, "utf8"));
  if (serverJson.version !== packageVersion) {
    throw new Error(
      `server.json version '${serverJson.version}' does not match package.json version '${packageVersion}'.`,
    );
  }
  if (!Array.isArray(serverJson.packages) || serverJson.packages.length === 0) {
    throw new Error("server.json packages array is missing or empty.");
  }
  const serverPackage = serverJson.packages[0];
  if (serverPackage.version !== packageVersion) {
    throw new Error(
      `server.json packages[0].version '${serverPackage.version}' does not match package.json version '${packageVersion}'.`,
    );
  }
  if (serverPackage.identifier !== "signalint-mcp") {
    throw new Error(
      `server.json packages[0].identifier must be 'signalint-mcp', got '${serverPackage.identifier}'.`,
    );
  }

  // 3. Verify action.yml if present
  const actionYmlPath = resolve(rootDir, "action.yml");
  if (existsSync(actionYmlPath)) {
    const actionYml = readFileSync(actionYmlPath, "utf8");
    const actionVersion = extractActionVersion(actionYml);
    if (actionVersion && actionVersion !== packageVersion) {
      throw new Error(
        `action.yml inputs.version.default '${actionVersion}' does not match package.json version '${packageVersion}'.`,
      );
    }
  }

  // 4. Verify release tag if event/tag environment variables are provided
  const eventName = env.EVENT_NAME || (env.GITHUB_EVENT_NAME ?? (env.INPUT_TAG ? "workflow_dispatch" : "push"));
  const inputTag = env.INPUT_TAG;
  const refName = env.REF_NAME || (env.GITHUB_REF ? env.GITHUB_REF.replace(/^refs\/tags\//, "") : undefined);
  const explicitTag = env.RELEASE_TAG;

  let validatedTag;
  if (explicitTag) {
    const cleanTag = explicitTag.replace(/^v/, "");
    if (cleanTag !== packageVersion) {
      throw new Error(`RELEASE_TAG '${explicitTag}' does not match package.json version '${packageVersion}'.`);
    }
    validatedTag = explicitTag.startsWith("v") ? explicitTag : `v${explicitTag}`;
  } else if (inputTag || refName) {
    validatedTag = resolveAndValidateReleaseTag({
      eventName,
      inputTag,
      refName,
      packageVersion,
    });
  }

  return {
    packageVersion,
    validatedTag,
    packageName: packageJson.name,
  };
}

function runCli() {
  const result = verifyReleaseMetadata({
    rootDir: process.cwd(),
    env: process.env,
  });

  console.log(`[verify-release-metadata] Metadata verified for ${result.packageName}@${result.packageVersion}`);
  if (result.validatedTag) {
    console.log(`[verify-release-metadata] Release tag verified: ${result.validatedTag}`);
    if (process.env.GITHUB_ENV) {
      appendFileSync(process.env.GITHUB_ENV, `RELEASE_TAG=${result.validatedTag}\n`);
    }
  }
}

const isMainModule =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)));

if (isMainModule) {
  try {
    runCli();
  } catch (error) {
    console.error(`[verify-release-metadata] Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
