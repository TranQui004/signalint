import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeHookAdapter } from "../src/hooks/adapters/claude.js";
import { cursorHookAdapter } from "../src/hooks/adapters/cursor.js";
import { codexHookAdapter } from "../src/hooks/adapters/codex.js";
import { vscodeHookAdapter } from "../src/hooks/adapters/vscode.js";
import { getHookAdapter } from "../src/hooks/adapters/index.js";
import { executeHookPolicy, formatBoundedSummary } from "../src/hooks/policy.js";
import type { NormalizedHookEvent } from "../src/hooks/event.js";
import type { NormalizedIssue } from "../src/schema.js";

const projectRoot = resolve(".");

function createMockIssue(id: string, rule = "mock-rule", severity: "error" | "warning" = "error"): NormalizedIssue {
  return {
    issueId: id,
    file: "src/index.ts",
    line: 1,
    col: 1,
    engine: "oxlint",
    rule,
    severity,
    message: `Message for ${id}`,
    fixable: false,
  };
}

describe("Claude Code Hook Adapter", () => {
  it("normalizes PostToolUse event with tool_input file path", () => {
    const raw = {
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: "src/index.ts" },
    };
    const event = claudeHookAdapter.normalizeEvent(raw, { defaultCwd: projectRoot });
    expect(event.runtime).toBe("claude");
    expect(event.eventType).toBe("post_edit");
    expect(event.files).toEqual(["src/index.ts"]);
  });

  it("normalizes Stop event", () => {
    const raw = { hook_event_name: "Stop" };
    const event = claudeHookAdapter.normalizeEvent(raw, { defaultCwd: projectRoot });
    expect(event.runtime).toBe("claude");
    expect(event.eventType).toBe("stop");
    expect(event.files).toEqual([]);
  });

  it("formats approved and blocked responses", () => {
    const event: NormalizedHookEvent = {
      runtime: "claude",
      eventType: "post_edit",
      files: ["src/index.ts"],
      cwd: projectRoot,
    };

    const cleanRes = claudeHookAdapter.formatResponse(event, {
      action: "approve",
      status: "clean",
      totalIssues: 0,
      omittedCount: 0,
    });
    expect(cleanRes).toEqual({ decision: "approve" });

    const blockRes = claudeHookAdapter.formatResponse(event, {
      action: "block",
      status: "issues_found",
      reason: "Type error in src/index.ts",
      additionalContext: "Details...",
      totalIssues: 1,
      omittedCount: 0,
    });
    expect(blockRes).toEqual({
      decision: "block",
      reason: "Type error in src/index.ts",
      additionalContext: "Details...",
    });
  });
});

describe("Cursor Hook Adapter", () => {
  it("normalizes afterFileEdit event", () => {
    const raw = {
      event: "afterFileEdit",
      file_path: "src/index.ts",
    };
    const event = cursorHookAdapter.normalizeEvent(raw, { defaultCwd: projectRoot });
    expect(event.runtime).toBe("cursor");
    expect(event.eventType).toBe("post_edit");
    expect(event.files).toEqual(["src/index.ts"]);
  });

  it("normalizes stop event", () => {
    const raw = { event: "stop" };
    const event = cursorHookAdapter.normalizeEvent(raw, { defaultCwd: projectRoot });
    expect(event.runtime).toBe("cursor");
    expect(event.eventType).toBe("stop");
  });

  it("formats approved and remediation responses", () => {
    const event: NormalizedHookEvent = {
      runtime: "cursor",
      eventType: "post_edit",
      files: ["src/index.ts"],
      cwd: projectRoot,
    };

    const cleanRes = cursorHookAdapter.formatResponse(event, {
      action: "approve",
      status: "clean",
    });
    expect(cleanRes).toEqual({});

    const issuesRes = cursorHookAdapter.formatResponse(event, {
      action: "block",
      status: "issues_found",
      reason: "Syntax error on line 12",
    });
    expect(issuesRes).toEqual({
      followup_message: "Syntax error on line 12",
      suggest_remediation: true,
    });
  });
});

describe("Codex Hook Adapter", () => {
  it("normalizes PostToolUse and Stop events", () => {
    const postEditRaw = {
      hook_event_name: "PostToolUse",
      tool_input: { path: "src/cli.ts" },
    };
    const postEvent = codexHookAdapter.normalizeEvent(postEditRaw, { defaultCwd: projectRoot });
    expect(postEvent.runtime).toBe("codex");
    expect(postEvent.eventType).toBe("post_edit");
    expect(postEvent.files).toEqual(["src/cli.ts"]);

    const stopRaw = { hook_event_name: "Stop" };
    const stopEvent = codexHookAdapter.normalizeEvent(stopRaw, { defaultCwd: projectRoot });
    expect(stopEvent.runtime).toBe("codex");
    expect(stopEvent.eventType).toBe("stop");
  });

  it("formats stop continuation fields", () => {
    const stopEvent: NormalizedHookEvent = {
      runtime: "codex",
      eventType: "stop",
      files: [],
      cwd: projectRoot,
    };

    const clean = codexHookAdapter.formatResponse(stopEvent, {
      action: "approve",
      status: "clean",
    });
    expect(clean).toEqual({ continue: false });

    const failed = codexHookAdapter.formatResponse(stopEvent, {
      action: "block",
      status: "issues_found",
      reason: "Unresolved errors",
    });
    expect(failed).toEqual({
      continue: true,
      stop_reason: "unresolved_diagnostics",
      message: "Unresolved errors",
    });
  });
});

describe("VS Code Hook Adapter", () => {
  it("normalizes PostToolUse with URI and stop events", () => {
    const raw = {
      event: "postToolUse",
      toolInput: { uri: "src/index.ts" },
    };
    const event = vscodeHookAdapter.normalizeEvent(raw, { defaultCwd: projectRoot });
    expect(event.runtime).toBe("vscode");
    expect(event.eventType).toBe("post_edit");
    expect(event.files).toEqual(["src/index.ts"]);

    const stopEvent = vscodeHookAdapter.normalizeEvent({ event: "stop" }, { defaultCwd: projectRoot });
    expect(stopEvent.eventType).toBe("stop");
  });

  it("formats decision structure", () => {
    const event: NormalizedHookEvent = {
      runtime: "vscode",
      eventType: "stop",
      files: [],
      cwd: projectRoot,
    };

    const clean = vscodeHookAdapter.formatResponse(event, {
      action: "approve",
      status: "clean",
    });
    expect(clean).toEqual({ decision: "continue" });

    const blocked = vscodeHookAdapter.formatResponse(event, {
      action: "block",
      status: "issues_found",
      reason: "Type check failed",
    });
    expect(blocked).toEqual({
      decision: "retry",
      reason: "Type check failed",
    });
  });
});

describe("Hook Adapter Registry", () => {
  it("resolves all supported runtime adapters", () => {
    expect(getHookAdapter("claude")).toBe(claudeHookAdapter);
    expect(getHookAdapter("cursor")).toBe(cursorHookAdapter);
    expect(getHookAdapter("codex")).toBe(codexHookAdapter);
    expect(getHookAdapter("vscode")).toBe(vscodeHookAdapter);
  });
});

describe("Hook Policy Decision Engine", () => {
  it("returns clean approval when no issues exist", async () => {
    const event: NormalizedHookEvent = {
      runtime: "claude",
      eventType: "post_edit",
      files: ["src/index.ts"],
      cwd: projectRoot,
    };

    const decision = await executeHookPolicy(event, {
      scopedChecker: async () => ({
        issues: [],
        engines: { oxlint: { status: "ok" }, tsc: { status: "ok" } },
        cache: { hits: 0, misses: 0 },
      }),
    });

    expect(decision.action).toBe("approve");
    expect(decision.status).toBe("clean");
    expect(decision.totalIssues).toBe(0);
    expect(decision.omittedCount).toBe(0);
  });

  it("approves post-edit with advisory context by default when issues exist below block threshold", async () => {
    const event: NormalizedHookEvent = {
      runtime: "claude",
      eventType: "post_edit",
      files: ["src/index.ts"],
      cwd: projectRoot,
    };

    const decision = await executeHookPolicy(event, {
      scopedChecker: async () => ({
        issues: [createMockIssue("1", "rule-1", "warning")],
        engines: { oxlint: { status: "ok" } },
        cache: { hits: 0, misses: 0 },
      }),
    });

    expect(decision.action).toBe("approve");
    expect(decision.status).toBe("issues_found");
    expect(decision.totalIssues).toBe(1);
    expect(decision.additionalContext).toContain("Signalint found 1 diagnostic issue");
  });

  it("blocks post-edit when failOnPriority threshold is exceeded", async () => {
    const event: NormalizedHookEvent = {
      runtime: "claude",
      eventType: "post_edit",
      files: ["src/index.ts"],
      cwd: projectRoot,
    };

    const decision = await executeHookPolicy(event, {
      failOnPriority: 1,
      scopedChecker: async () => ({
        issues: [createMockIssue("1", "rule-error", "error")],
        engines: { oxlint: { status: "ok" } },
        cache: { hits: 0, misses: 0 },
      }),
    });

    expect(decision.action).toBe("block");
    expect(decision.status).toBe("issues_found");
    expect(decision.reason).toContain("Signalint found 1 diagnostic issue");
  });

  it("blocks stop policy when unresolved threshold errors exist", async () => {
    const event: NormalizedHookEvent = {
      runtime: "vscode",
      eventType: "stop",
      files: [],
      cwd: projectRoot,
    };

    const decision = await executeHookPolicy(event, {
      projectChecker: async () => ({
        issues: [createMockIssue("1", "fatal-error", "error")],
        engines: { oxlint: { status: "ok" } },
        cache: { hits: 0, misses: 0 },
      }),
    });

    expect(decision.action).toBe("block");
    expect(decision.status).toBe("issues_found");
    expect(decision.reason).toContain("Verification failed: 1 unresolved issue(s) remaining at priority <= 1");
  });

  it("never reports green on engine failure at stop hook", async () => {
    const event: NormalizedHookEvent = {
      runtime: "cursor",
      eventType: "stop",
      files: [],
      cwd: projectRoot,
    };

    const decision = await executeHookPolicy(event, {
      projectChecker: async () => ({
        issues: [],
        engines: {
          oxlint: { status: "ok" },
          tsc: { status: "error", error: "tsc crashed: heap out of memory" },
        },
        cache: { hits: 0, misses: 0 },
      }),
    });

    expect(decision.action).toBe("block");
    expect(decision.status).toBe("error");
    expect(decision.engineFailures).toContain("tsc");
    expect(decision.reason).toContain("Diagnostic engine(s) failed (tsc)");
  });

  it("strictly bounds issue summary and computes exact omission count with 100+ issues", () => {
    const issues: NormalizedIssue[] = [];
    for (let i = 0; i < 120; i++) {
      issues.push(createMockIssue(`issue-${i}`, `rule-${i % 5}`));
    }

    const summary = formatBoundedSummary(120, issues, 5, []);
    expect(summary).toContain("Signalint found 120 diagnostic issues:");
    expect(summary).toContain("• [ERROR] src/index.ts:1:1 (rule-0)");
    expect(summary).toContain("• [ERROR] src/index.ts:1:1 (rule-4)");
    expect(summary).toContain("(... and 115 more issues omitted)");
  });
});
