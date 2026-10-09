import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { HookRuntime } from "./event.js";
import { isRecord } from "../util/index.js";

export interface HookConfigSpec {
  runtime: HookRuntime;
  relativePath: string;
  generateHooksObject(): Record<string, unknown>;
  mergeExisting(existing: Record<string, unknown>): Record<string, unknown>;
}

export interface HookPreviewResult {
  runtime: HookRuntime;
  targetPath: string;
  exists: boolean;
  previewContent: string;
  merged: boolean;
}

export interface HookInstallResult {
  runtime: HookRuntime;
  targetPath: string;
  action: "created" | "merged" | "already_installed";
  content: string;
}

const RUNTIME_CONFIG_SPECS: Record<HookRuntime, HookConfigSpec> = {
  claude: {
    runtime: "claude",
    relativePath: ".claude/config.json",
    generateHooksObject: () => ({
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write|MultiEdit",
            command: "npx signalint-mcp hooks run --runtime claude --event post_edit",
          },
        ],
        Stop: [
          {
            command: "npx signalint-mcp hooks run --runtime claude --event stop",
          },
        ],
      },
    }),
    mergeExisting: (existing) => {
      const result = { ...existing };
      const hooks = isRecord(result["hooks"]) ? { ...result["hooks"] } : {};

      const postToolUse = Array.isArray(hooks["PostToolUse"]) ? [...hooks["PostToolUse"]] : [];
      const hasSignalintPost = postToolUse.some(
        (entry) => isRecord(entry) && String(entry["command"] ?? "").includes("signalint-mcp"),
      );
      if (!hasSignalintPost) {
        postToolUse.push({
          matcher: "Edit|Write|MultiEdit",
          command: "npx signalint-mcp hooks run --runtime claude --event post_edit",
        });
      }
      hooks["PostToolUse"] = postToolUse;

      const stopHooks = Array.isArray(hooks["Stop"]) ? [...hooks["Stop"]] : [];
      const hasSignalintStop = stopHooks.some(
        (entry) => isRecord(entry) && String(entry["command"] ?? "").includes("signalint-mcp"),
      );
      if (!hasSignalintStop) {
        stopHooks.push({
          command: "npx signalint-mcp hooks run --runtime claude --event stop",
        });
      }
      hooks["Stop"] = stopHooks;

      result["hooks"] = hooks;
      return result;
    },
  },

  cursor: {
    runtime: "cursor",
    relativePath: ".cursor/hooks.json",
    generateHooksObject: () => ({
      version: 1,
      hooks: {
        afterFileEdit: {
          command: "npx signalint-mcp hooks run --runtime cursor --event post_edit",
        },
        stop: {
          command: "npx signalint-mcp hooks run --runtime cursor --event stop",
        },
      },
    }),
    mergeExisting: (existing) => {
      const result = { ...existing };
      result["version"] = result["version"] ?? 1;
      const hooks = isRecord(result["hooks"]) ? { ...result["hooks"] } : {};

      hooks["afterFileEdit"] = {
        command: "npx signalint-mcp hooks run --runtime cursor --event post_edit",
      };
      hooks["stop"] = {
        command: "npx signalint-mcp hooks run --runtime cursor --event stop",
      };

      result["hooks"] = hooks;
      return result;
    },
  },

  codex: {
    runtime: "codex",
    relativePath: ".codex/hooks.json",
    generateHooksObject: () => ({
      hooks: {
        PostToolUse: [
          {
            command: "npx signalint-mcp hooks run --runtime codex --event post_edit",
          },
        ],
        Stop: [
          {
            command: "npx signalint-mcp hooks run --runtime codex --event stop",
          },
        ],
      },
    }),
    mergeExisting: (existing) => {
      const result = { ...existing };
      const hooks = isRecord(result["hooks"]) ? { ...result["hooks"] } : {};

      const postHooks = Array.isArray(hooks["PostToolUse"]) ? [...hooks["PostToolUse"]] : [];
      if (!postHooks.some((h) => isRecord(h) && String(h["command"] ?? "").includes("signalint-mcp"))) {
        postHooks.push({
          command: "npx signalint-mcp hooks run --runtime codex --event post_edit",
        });
      }
      hooks["PostToolUse"] = postHooks;

      const stopHooks = Array.isArray(hooks["Stop"]) ? [...hooks["Stop"]] : [];
      if (!stopHooks.some((h) => isRecord(h) && String(h["command"] ?? "").includes("signalint-mcp"))) {
        stopHooks.push({
          command: "npx signalint-mcp hooks run --runtime codex --event stop",
        });
      }
      hooks["Stop"] = stopHooks;

      result["hooks"] = hooks;
      return result;
    },
  },

  vscode: {
    runtime: "vscode",
    relativePath: ".vscode/hooks.json",
    generateHooksObject: () => ({
      hooks: {
        postToolUse: {
          command: "npx signalint-mcp hooks run --runtime vscode --event post_edit",
        },
        stop: {
          command: "npx signalint-mcp hooks run --runtime vscode --event stop",
        },
      },
    }),
    mergeExisting: (existing) => {
      const result = { ...existing };
      const hooks = isRecord(result["hooks"]) ? { ...result["hooks"] } : {};

      hooks["postToolUse"] = {
        command: "npx signalint-mcp hooks run --runtime vscode --event post_edit",
      };
      hooks["stop"] = {
        command: "npx signalint-mcp hooks run --runtime vscode --event stop",
      };

      result["hooks"] = hooks;
      return result;
    },
  },
};

/** Generates a preview of the configuration that would be written or merged for a host runtime. */
export async function previewHookInstall(
  runtime: HookRuntime,
  cwd: string = process.cwd(),
): Promise<HookPreviewResult> {
  const spec = RUNTIME_CONFIG_SPECS[runtime];
  const targetPath = resolve(cwd, spec.relativePath);
  const exists = existsSync(targetPath);

  if (exists) {
    try {
      const raw = await readFile(targetPath, "utf8");
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) {
        const merged = spec.mergeExisting(parsed);
        return {
          runtime,
          targetPath,
          exists: true,
          merged: true,
          previewContent: `${JSON.stringify(merged, null, 2)}\n`,
        };
      }
    } catch {
      // If parsing failed, fall back to fresh template preview
    }
  }

  const fresh = spec.generateHooksObject();
  return {
    runtime,
    targetPath,
    exists: false,
    merged: false,
    previewContent: `${JSON.stringify(fresh, null, 2)}\n`,
  };
}

/** Safely installs or merges hook definitions into the target assistant host's project configuration. */
export async function installHook(
  runtime: HookRuntime,
  cwd: string = process.cwd(),
): Promise<HookInstallResult> {
  const spec = RUNTIME_CONFIG_SPECS[runtime];
  const targetPath = resolve(cwd, spec.relativePath);
  const exists = existsSync(targetPath);

  let finalContent: string;
  let action: "created" | "merged" | "already_installed" = "created";

  if (exists) {
    const raw = await readFile(targetPath, "utf8");
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(raw);
    } catch (e: unknown) {
      throw new Error(`Failed to parse existing configuration file at ${targetPath}: ${String(e)}`);
    }

    if (!isRecord(parsed)) {
      throw new Error(`Existing configuration at ${targetPath} is not a JSON object.`);
    }

    const merged = spec.mergeExisting(parsed);
    finalContent = `${JSON.stringify(merged, null, 2)}\n`;

    if (finalContent.trim() === raw.trim()) {
      action = "already_installed";
    } else {
      action = "merged";
    }
  } else {
    const fresh = spec.generateHooksObject();
    finalContent = `${JSON.stringify(fresh, null, 2)}\n`;
    await mkdir(dirname(targetPath), { recursive: true });
    action = "created";
  }

  if (action !== "already_installed") {
    await writeFile(targetPath, finalContent, "utf8");
  }

  return {
    runtime,
    targetPath,
    action,
    content: finalContent,
  };
}
