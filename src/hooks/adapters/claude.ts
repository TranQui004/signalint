import type { HookAdapter, HookDecision, HookEventType, NormalizedHookEvent } from "../event.js";
import { normalizeHookPaths } from "../paths.js";
import { isRecord } from "../../util/index.js";

export interface ClaudeHookOutput {
  decision?: "approve" | "block";
  reason?: string;
  additionalContext?: string;
}

export const claudeHookAdapter: HookAdapter<unknown, ClaudeHookOutput> = {
  runtime: "claude",

  /** Normalizes a Claude Code hook payload into a standard NormalizedHookEvent. */
  normalizeEvent(rawPayload: unknown, options = {}): NormalizedHookEvent {
    const payload = isRecord(rawPayload) ? rawPayload : {};
    const cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : (options.defaultCwd ?? process.cwd());

    let eventType: HookEventType = options.eventType ?? "post_edit";
    const eventName = String(payload["hook_event_name"] ?? payload["event"] ?? "").toLowerCase();
    if (eventName === "stop" || options.eventType === "stop") {
      eventType = "stop";
    }

    const rawFiles: string[] = [];
    const toolInput = isRecord(payload["tool_input"])
      ? payload["tool_input"]
      : isRecord(payload["toolInput"])
        ? payload["toolInput"]
        : {};

    extractFilePath(toolInput["file_path"], rawFiles);
    extractFilePath(toolInput["filePath"], rawFiles);
    extractFilePath(toolInput["path"], rawFiles);
    extractFilePaths(toolInput["files"], rawFiles);
    extractFilePaths(toolInput["paths"], rawFiles);

    extractFilePath(payload["file_path"], rawFiles);
    extractFilePath(payload["filePath"], rawFiles);
    extractFilePaths(payload["files"], rawFiles);

    const files = normalizeHookPaths(rawFiles, cwd);

    return {
      runtime: "claude",
      eventType,
      files,
      cwd,
      rawPayload,
    };
  },

  /** Formats a verification decision into Claude Code's native JSON output format. */
  formatResponse(_event: NormalizedHookEvent, decision: HookDecision): ClaudeHookOutput {
    if (decision.action === "block") {
      return {
        decision: "block",
        reason: decision.reason ?? decision.summary ?? "Verification blocked.",
        ...(decision.additionalContext !== undefined ? { additionalContext: decision.additionalContext } : {}),
      };
    }

    return {
      decision: "approve",
      ...(decision.additionalContext !== undefined ? { additionalContext: decision.additionalContext } : {}),
    };
  },
};

function extractFilePath(value: unknown, target: string[]): void {
  if (typeof value === "string" && value.trim() !== "") {
    target.push(value.trim());
  }
}

function extractFilePaths(value: unknown, target: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      extractFilePath(item, target);
    }
  }
}
