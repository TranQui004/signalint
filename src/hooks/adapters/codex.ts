import type { HookAdapter, HookDecision, HookEventType, NormalizedHookEvent } from "../event.js";
import { normalizeHookPaths } from "../paths.js";
import { isRecord } from "../../util/index.js";

export interface CodexHookOutput {
  continue: boolean;
  stop_reason?: string | undefined;
  message?: string | undefined;
}

export const codexHookAdapter: HookAdapter<unknown, CodexHookOutput> = {
  runtime: "codex",

  /** Normalizes a Codex hook payload into a standard NormalizedHookEvent. */
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

    extractFilePath(payload["file_path"], rawFiles);
    extractFilePath(payload["path"], rawFiles);
    extractFilePaths(payload["files"], rawFiles);

    const files = normalizeHookPaths(rawFiles, cwd);

    return {
      runtime: "codex",
      eventType,
      files,
      cwd,
      rawPayload,
    };
  },

  /** Formats a verification decision into Codex's native continuation fields. */
  formatResponse(event: NormalizedHookEvent, decision: HookDecision): CodexHookOutput {
    if (event.eventType === "stop") {
      if (decision.action === "block" || decision.status !== "clean") {
        return {
          continue: true,
          stop_reason: "unresolved_diagnostics",
          message: decision.reason ?? decision.summary ?? "Verification issues remaining at stop.",
        };
      }
      return {
        continue: false,
      };
    }

    // Post-edit
    if (decision.action === "block") {
      return {
        continue: true,
        message: decision.reason ?? decision.summary,
      };
    }

    return {
      continue: false,
      ...(decision.additionalContext !== undefined ? { message: decision.additionalContext } : {}),
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
