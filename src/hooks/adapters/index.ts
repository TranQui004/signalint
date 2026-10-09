import type { HookAdapter, HookRuntime } from "../event.js";
import { claudeHookAdapter } from "./claude.js";
import { cursorHookAdapter } from "./cursor.js";
import { codexHookAdapter } from "./codex.js";
import { vscodeHookAdapter } from "./vscode.js";

export {
  claudeHookAdapter,
  cursorHookAdapter,
  codexHookAdapter,
  vscodeHookAdapter,
};

const ADAPTER_MAP: Record<HookRuntime, HookAdapter<unknown, unknown>> = {
  claude: claudeHookAdapter,
  cursor: cursorHookAdapter,
  codex: codexHookAdapter,
  vscode: vscodeHookAdapter,
};

/** Retrieves the registered hook adapter for a supported AI assistant host runtime. */
export function getHookAdapter(runtime: HookRuntime): HookAdapter<unknown, unknown> {
  const adapter = ADAPTER_MAP[runtime];
  if (!adapter) {
    throw new Error(`Unsupported hook runtime: ${runtime}`);
  }
  return adapter;
}
