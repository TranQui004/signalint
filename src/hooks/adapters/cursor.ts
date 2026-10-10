import type { HookAdapter, HookDecision, HookEventType, NormalizedHookEvent } from "../event.js";
import { normalizeHookPaths } from "../paths.js";
import { isRecord } from "../../util/index.js";

export interface CursorHookOutput {
  followup_message?: string | undefined;
  suggest_remediation?: boolean | undefined;
}

export const cursorHookAdapter: HookAdapter<unknown, CursorHookOutput> = {
  runtime: "cursor",

  /** Normalizes a Cursor hook payload into a standard NormalizedHookEvent. */
  normalizeEvent(rawPayload: unknown, options = {}): NormalizedHookEvent {
    const payload = isRecord(rawPayload) ? rawPayload : {};
    const cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : (options.defaultCwd ?? process.cwd());

    let eventType: HookEventType = options.eventType ?? "post_edit";
    const eventName = String(payload["event"] ?? payload["type"] ?? payload["hook"] ?? "").toLowerCase();
    if (eventName === "stop" || options.eventType === "stop") {
      eventType = "stop";
    }

    const rawFiles: string[] = [];
    extractFilePath(payload["file"], rawFiles);
    extractFilePath(payload["filePath"], rawFiles);
    extractFilePath(payload["file_path"], rawFiles);
    extractFilePath(payload["path"], rawFiles);
    extractFilePaths(payload["files"], rawFiles);
    extractFilePaths(payload["filePaths"], rawFiles);
    extractFilePaths(payload["file_paths"], rawFiles);

    const files = normalizeHookPaths(rawFiles, cwd);

    return {
      runtime: "cursor",
      eventType,
      files,
      cwd,
      rawPayload,
    };
  },

  /** Formats a verification decision into Cursor's native remediation message output. */
  formatResponse(_event: NormalizedHookEvent, decision: HookDecision): CursorHookOutput {
    if (decision.status === "clean" && decision.action === "approve") {
      return {};
    }

    const message = decision.reason ?? decision.summary ?? decision.followupMessage;
    if (message !== undefined) {
      return {
        followup_message: message,
        suggest_remediation: true,
      };
    }

    return {};
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
