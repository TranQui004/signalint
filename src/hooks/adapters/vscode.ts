import type { HookAdapter, HookDecision, HookEventType, NormalizedHookEvent } from "../event.js";
import { normalizeHookPaths } from "../paths.js";
import { isRecord } from "../../util/index.js";

export interface VsCodeHookOutput {
  decision: "continue" | "retry";
  reason?: string | undefined;
}

export const vscodeHookAdapter: HookAdapter<unknown, VsCodeHookOutput> = {
  runtime: "vscode",

  /** Normalizes a VS Code Agent hook payload into a standard NormalizedHookEvent. */
  normalizeEvent(rawPayload: unknown, options = {}): NormalizedHookEvent {
    const payload = isRecord(rawPayload) ? rawPayload : {};
    const cwd = typeof payload["cwd"] === "string" ? payload["cwd"] : (options.defaultCwd ?? process.cwd());

    let eventType: HookEventType = options.eventType ?? "post_edit";
    const eventName = String(
      payload["event"] ?? payload["type"] ?? payload["hookName"] ?? "",
    ).toLowerCase();
    if (eventName === "stop" || options.eventType === "stop") {
      eventType = "stop";
    }

    const rawFiles: string[] = [];
    const toolInput = isRecord(payload["toolInput"])
      ? payload["toolInput"]
      : isRecord(payload["input"])
        ? payload["input"]
        : {};

    extractFilePath(toolInput["uri"], rawFiles);
    extractFilePath(toolInput["path"], rawFiles);
    extractFilePath(toolInput["filePath"], rawFiles);
    extractFilePaths(toolInput["files"], rawFiles);

    extractFilePath(payload["uri"], rawFiles);
    extractFilePath(payload["path"], rawFiles);
    extractFilePath(payload["filePath"], rawFiles);
    extractFilePaths(payload["files"], rawFiles);

    const files = normalizeHookPaths(rawFiles, cwd);

    return {
      runtime: "vscode",
      eventType,
      files,
      cwd,
      rawPayload,
    };
  },

  /** Formats a verification decision into VS Code Agent's native continue/retry structure. */
  formatResponse(event: NormalizedHookEvent, decision: HookDecision): VsCodeHookOutput {
    if (event.eventType === "stop") {
      if (decision.action === "block" || decision.status !== "clean") {
        return {
          decision: "retry",
          reason: decision.reason ?? decision.summary ?? "Verification issues remaining at stop.",
        };
      }
      return {
        decision: "continue",
      };
    }

    // Post-edit
    if (decision.action === "block") {
      return {
        decision: "retry",
        reason: decision.reason ?? decision.summary,
      };
    }

    return {
      decision: "continue",
    };
  },
};

function extractFilePath(value: unknown, target: string[]): void {
  if (typeof value === "string" && value.trim() !== "") {
    let cleaned = value.trim();
    if (cleaned.startsWith("file://")) {
      try {
        cleaned = decodeURIComponent(new URL(cleaned).pathname);
        if (/^\/[A-Za-z]:/.test(cleaned)) {
          cleaned = cleaned.slice(1);
        }
      } catch {
        // keep as is
      }
    }
    target.push(cleaned);
  }
}

function extractFilePaths(value: unknown, target: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      extractFilePath(item, target);
    }
  }
}
