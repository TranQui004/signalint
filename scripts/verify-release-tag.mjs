import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves and validates the release tag for a release workflow run.
 * Ensures manual dispatches supply an explicit, valid tag matching package.json,
 * and tag pushes have a valid tag matching package.json.
 */
export function resolveAndValidateReleaseTag({ eventName, inputTag, refName, packageVersion }) {
  if (eventName === "workflow_dispatch") {
    if (!inputTag || typeof inputTag !== "string" || inputTag.trim() === "") {
      throw new Error("Manual dispatch requires an explicit, non-empty release tag (e.g. v1.1.2).");
    }
    const tag = inputTag.trim();
    if (!/^v\d+\.\d+\.\d+.*$/.test(tag)) {
      throw new Error(
        `Manual dispatch tag must start with 'v' and follow semantic versioning (e.g. v1.1.2), received: '${tag}'.`,
      );
    }
    const tagVersion = tag.replace(/^v/, "");
    if (tagVersion !== packageVersion) {
      throw new Error(`Tag '${tag}' does not match package.json version '${packageVersion}'.`);
    }
    return tag;
  }

  if (eventName === "push") {
    if (!refName || typeof refName !== "string") {
      throw new Error("Tag push event did not provide refName.");
    }
    if (!/^v\d+\.\d+\.\d+.*$/.test(refName)) {
      throw new Error(
        `Pushed tag ref must start with 'v' and follow semantic versioning (e.g. v1.1.2), received: '${refName}'.`,
      );
    }
    const tagVersion = refName.replace(/^v/, "");
    if (tagVersion !== packageVersion) {
      throw new Error(`Pushed tag '${refName}' does not match package.json version '${packageVersion}'.`);
    }
    return refName;
  }

  throw new Error(`Unsupported event type: '${eventName}'.`);
}

function runCli() {
  const packageJsonPath = resolve(process.cwd(), "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const eventName = process.env.EVENT_NAME || "push";
  const inputTag = process.env.INPUT_TAG;
  const refName = process.env.REF_NAME;

  const tag = resolveAndValidateReleaseTag({
    eventName,
    inputTag,
    refName,
    packageVersion: packageJson.version,
  });

  console.log(`Validated release tag: ${tag} (matches package.json version ${packageJson.version})`);

  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `RELEASE_TAG=${tag}\n`);
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
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
