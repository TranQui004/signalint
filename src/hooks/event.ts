/**
 * Defines core normalized hook event shapes and decision models across AI coding assistant hosts.
 */

export type HookRuntime = "claude" | "cursor" | "codex" | "vscode";
export type HookEventType = "post_edit" | "stop";

export const SUPPORTED_HOOK_RUNTIMES: readonly HookRuntime[] = [
  "claude",
  "cursor",
  "codex",
  "vscode",
];

export const SUPPORTED_HOOK_EVENT_TYPES: readonly HookEventType[] = [
  "post_edit",
  "stop",
];

export interface NormalizedHookEvent {
  runtime: HookRuntime;
  eventType: HookEventType;
  files: string[];
  cwd: string;
  rawPayload?: unknown;
}

export type HookDecisionAction = "approve" | "block" | "continue" | "retry";

export interface HookDecision {
  action: HookDecisionAction;
  status: "clean" | "issues_found" | "error";
  reason?: string | undefined;
  additionalContext?: string | undefined;
  followupMessage?: string | undefined;
  summary?: string | undefined;
  totalIssues?: number | undefined;
  omittedCount?: number | undefined;
  engineFailures?: string[] | undefined;
}

/** Checks whether a value is a supported hook runtime identifier. */
export function isHookRuntime(value: unknown): value is HookRuntime {
  return typeof value === "string" && (SUPPORTED_HOOK_RUNTIMES as readonly string[]).includes(value);
}

/** Checks whether a value is a supported hook event type. */
export function isHookEventType(value: unknown): value is HookEventType {
  return typeof value === "string" && (SUPPORTED_HOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export interface HookAdapter<TRaw = unknown, TOutput = unknown> {
  readonly runtime: HookRuntime;
  normalizeEvent(
    rawPayload: TRaw,
    options?: { defaultCwd?: string | undefined; eventType?: HookEventType | undefined },
  ): NormalizedHookEvent;
  formatResponse(event: NormalizedHookEvent, decision: HookDecision): TOutput;
}
