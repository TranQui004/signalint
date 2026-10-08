import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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
});
