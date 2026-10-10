import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { extractActionVersion, verifyReleaseMetadata } from "../scripts/verify-release-metadata.mjs";
import { resolveAndValidateReleaseTag } from "../scripts/verify-release-tag.mjs";

describe("release tag validation and resolution", () => {
  it("resolves and validates valid tag for workflow_dispatch", () => {
    const tag = resolveAndValidateReleaseTag({
      eventName: "workflow_dispatch",
      inputTag: "v1.1.2",
      packageVersion: "1.1.2",
    });
    expect(tag).toBe("v1.1.2");
  });

  it("fails closed on workflow_dispatch when tag input is omitted or empty", () => {
    expect(() =>
      resolveAndValidateReleaseTag({
        eventName: "workflow_dispatch",
        inputTag: undefined,
        packageVersion: "1.1.2",
      }),
    ).toThrow(/requires an explicit, non-empty release tag/);

    expect(() =>
      resolveAndValidateReleaseTag({
        eventName: "workflow_dispatch",
        inputTag: "",
        packageVersion: "1.1.2",
      }),
    ).toThrow(/requires an explicit, non-empty release tag/);

    expect(() =>
      resolveAndValidateReleaseTag({
        eventName: "workflow_dispatch",
        inputTag: "   ",
        packageVersion: "1.1.2",
      }),
    ).toThrow(/requires an explicit, non-empty release tag/);
  });

  it("fails closed on workflow_dispatch when tag format does not start with 'v'", () => {
    expect(() =>
      resolveAndValidateReleaseTag({
        eventName: "workflow_dispatch",
        inputTag: "1.1.2",
        packageVersion: "1.1.2",
      }),
    ).toThrow(/must start with 'v'/);
  });

  it("fails closed on workflow_dispatch when tag does not match package.json", () => {
    expect(() =>
      resolveAndValidateReleaseTag({
        eventName: "workflow_dispatch",
        inputTag: "v1.1.3",
        packageVersion: "1.1.2",
      }),
    ).toThrow(/does not match package\.json version/);
  });

  it("resolves and validates tag from refName for push events", () => {
    const tag = resolveAndValidateReleaseTag({
      eventName: "push",
      refName: "v1.1.2",
      packageVersion: "1.1.2",
    });
    expect(tag).toBe("v1.1.2");
  });

  it("fails closed on push events when refName is missing, malformed, or mismatched", () => {
    expect(() =>
      resolveAndValidateReleaseTag({
        eventName: "push",
        refName: undefined,
        packageVersion: "1.1.2",
      }),
    ).toThrow(/did not provide refName/);

    expect(() =>
      resolveAndValidateReleaseTag({
        eventName: "push",
        refName: "main",
        packageVersion: "1.1.2",
      }),
    ).toThrow(/must start with 'v'/);

    expect(() =>
      resolveAndValidateReleaseTag({
        eventName: "push",
        refName: "v1.0.0",
        packageVersion: "1.1.2",
      }),
    ).toThrow(/does not match package\.json version/);
  });

  it("fails on unsupported event type", () => {
    expect(() =>
      resolveAndValidateReleaseTag({
        eventName: "pull_request" as "push",
        packageVersion: "1.1.2",
      }),
    ).toThrow(/Unsupported event type/);
  });
});

describe("release metadata verification script", () => {
  it("verifies current workspace release metadata consistently", () => {
    const result = verifyReleaseMetadata({
      rootDir: process.cwd(),
      env: { RELEASE_TAG: "v1.2.0" },
    });
    expect(result.packageName).toBe("signalint-mcp");
    expect(result.packageVersion).toBe("1.2.0");
    expect(result.validatedTag).toBe("v1.2.0");
  });

  it("fails closed when RELEASE_TAG mismatches package.json version", () => {
    expect(() =>
      verifyReleaseMetadata({
        rootDir: process.cwd(),
        env: { RELEASE_TAG: "v9.9.9" },
      }),
    ).toThrow(/does not match package\.json version/);
  });

  it("extracts action.yml inputs.version.default correctly", () => {
    const sampleYml = `
name: Signalint
inputs:
  version:
    description: 'Version of Signalint'
    required: false
    default: '1.2.0'
`;
    expect(extractActionVersion(sampleYml)).toBe("1.2.0");
    expect(extractActionVersion("no version input here")).toBeUndefined();
  });
});

describe("release workflow definition", () => {
  it("configures workflow_dispatch to require an explicit tag with no stale default", () => {
    const workflowPath = resolve(process.cwd(), ".github/workflows/release.yml");
    const content = readFileSync(workflowPath, "utf8");

    // Extract workflow_dispatch inputs section up to next top-level key
    const workflowDispatchMatch = content.match(
      /workflow_dispatch:[\s\S]*?inputs:[\s\S]*?tag:[\s\S]*?(?=\r?\npermissions:)/,
    );
    expect(workflowDispatchMatch).not.toBeNull();
    const tagInputSection = workflowDispatchMatch ? workflowDispatchMatch[0] : "";

    expect(tagInputSection).toMatch(/required:\s*true/);
    expect(tagInputSection).not.toMatch(/default:/);
    expect(tagInputSection).not.toContain("default: 'v1.0.0'");
  });

  it("pins all external GitHub Actions to immutable 40-character commit SHAs in ci.yml, release.yml, and action.yml", () => {
    const workflows = [".github/workflows/ci.yml", ".github/workflows/release.yml", "action.yml"];
    const shaPattern = /^[a-f0-9]{40}$/;

    for (const relPath of workflows) {
      const fullPath = resolve(process.cwd(), relPath);
      const content = readFileSync(fullPath, "utf8");
      const usesMatches = content.match(/uses:\s+([^#\r\n]+)/g) || [];

      expect(usesMatches.length).toBeGreaterThan(0);
      for (const match of usesMatches) {
        const actionRef = match.replace(/uses:\s+/, "").trim();
        const parts = actionRef.split("@");
        expect(parts).toHaveLength(2);
        const [actionName, commitSha] = parts;
        expect(actionName).toMatch(/^[\w-]+\/[\w-]+$/);
        expect(commitSha).toMatch(shaPattern);
      }

      expect(content).not.toMatch(/uses:\s+[^@\r\n]+@v\d+/);
      expect(content).not.toMatch(/uses:\s+[^@\r\n]+@main\b/);
      expect(content).not.toMatch(/uses:\s+[^@\r\n]+@master\b/);
    }
  });

  it("enforces pre-publish gate, cache isolation, and provenance permissions in release.yml", () => {
    const workflowPath = resolve(process.cwd(), ".github/workflows/release.yml");
    const content = readFileSync(workflowPath, "utf8");

    // Publish job requires gate completion
    expect(content).toMatch(/publish:[\s\S]*?needs:\s*gate/);

    // Publish job requires id-token write and contents write permissions
    expect(content).toMatch(/permissions:[\s\S]*?contents:\s*write[\s\S]*?id-token:\s*write/);

    // Publish job does not configure cache: pnpm
    const publishJobMatch = content.match(/publish:[\s\S]*$/);
    expect(publishJobMatch).not.toBeNull();
    const publishJobContent = publishJobMatch ? publishJobMatch[0] : "";
    expect(publishJobContent).not.toMatch(/cache:\s*pnpm/);

    // Smoke test is executed strictly before npm publish in publish job
    const smokeIndex = publishJobContent.indexOf("smoke-tarball.mjs");
    const publishIndex = publishJobContent.indexOf("npm publish");
    expect(smokeIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(-1);
    expect(smokeIndex).toBeLessThan(publishIndex);

    // Provenance flag is included in npm publish
    expect(publishJobContent).toMatch(/npm publish [^\r\n]*--provenance/);
  });

  it("enforces that all verification and tarball checks occur strictly before npm publish", () => {
    const workflowPath = resolve(process.cwd(), ".github/workflows/release.yml");
    const content = readFileSync(workflowPath, "utf8");

    const publishJobMatch = content.match(/publish:[\s\S]*$/);
    expect(publishJobMatch).not.toBeNull();
    const publishJob = publishJobMatch ? publishJobMatch[0] : "";

    const verifyMetadataIdx = publishJob.indexOf("Verify release metadata");
    const packTarballIdx = publishJob.indexOf("Pack and inspect release tarball");
    const smokeTestIdx = publishJob.indexOf("Smoke test verified tarball");
    const npmPublishIdx = publishJob.indexOf("- name: Publish to npm");

    expect(verifyMetadataIdx).toBeGreaterThan(-1);
    expect(packTarballIdx).toBeGreaterThan(-1);
    expect(smokeTestIdx).toBeGreaterThan(-1);
    expect(npmPublishIdx).toBeGreaterThan(-1);

    // Strict sequential ordering: metadata -> pack -> smoke -> publish
    expect(verifyMetadataIdx).toBeLessThan(packTarballIdx);
    expect(packTarballIdx).toBeLessThan(smokeTestIdx);
    expect(smokeTestIdx).toBeLessThan(npmPublishIdx);

    // Ensure no server.json, tarball inspection, or metadata check occurs after npm publish
    const postPublishSection = publishJob.slice(npmPublishIdx);
    expect(postPublishSection).not.toContain("verify-release-metadata.mjs");
    expect(postPublishSection).not.toContain("smoke-tarball.mjs");
    expect(postPublishSection).not.toContain("server.json");
    expect(postPublishSection).not.toContain(".tarball-inspect");
    expect(postPublishSection).not.toContain("npm pack");
  });

  it("documents release workflow operational order accurately in RELEASE.md", () => {
    const releaseMdPath = resolve(process.cwd(), "RELEASE.md");
    const content = readFileSync(releaseMdPath, "utf8");

    const verifyMetadataIdx = content.indexOf("Verify release metadata");
    const smokeTestIdx = content.indexOf("Smoke test verified tarball");
    const publishNpmIdx = content.indexOf("Publish to npm");

    expect(verifyMetadataIdx).toBeGreaterThan(-1);
    expect(smokeTestIdx).toBeGreaterThan(-1);
    expect(publishNpmIdx).toBeGreaterThan(-1);

    // Pre-publish validations precede npm publish in documentation
    expect(verifyMetadataIdx).toBeLessThan(publishNpmIdx);
    expect(smokeTestIdx).toBeLessThan(publishNpmIdx);

    // Explicit invariant statement
    expect(content).toContain("All deterministic metadata and artifact checks run before `npm publish`");

    // Absence of obsolete post-publish server.json verification or dry-run pack phrasing
    expect(content).not.toMatch(/npm pack --dry-run/);
    expect(content).not.toMatch(/Verifies server\.json matches package\.json,\s*then publishes/i);
  });

  it("runs smoke-tarball in ci.yml steps", () => {
    const ciPath = resolve(process.cwd(), ".github/workflows/ci.yml");
    const content = readFileSync(ciPath, "utf8");
    expect(content).toMatch(/node scripts\/smoke-tarball\.mjs/);
  });
});
