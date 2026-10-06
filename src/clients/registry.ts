import { existsSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";

export type McpClientScope = "project" | "user";
export type McpClientFormat = "mcpServers" | "servers" | "toml" | "zed";

export interface McpClientSpec {
  id: string;
  label: string;
  scope: McpClientScope;
  configPath: (projectRoot: string, home: string) => string;
  format: McpClientFormat;
  serverKey: string;
  supportsCwd: boolean;
  marker: (projectRoot: string) => string;
  addCommand?: string;
  docsUrl: string;
}

/** Resolves path using either win32 or posix based on the base path format. */
export function resolveWithBase(base: string, ...parts: string[]): string {
  if (/^[A-Za-z]:[\\/]/.test(base) || base.includes("\\")) {
    return win32.resolve(base, ...parts);
  }
  if (base.startsWith("/")) {
    return posix.resolve(base, ...parts);
  }
  return resolve(base, ...parts);
}

/** Returns primary marker path if existing or fallback if present. */
export function resolveMarker(projectRoot: string, primary: string, fallback?: string): string {
  const primaryPath = resolveWithBase(projectRoot, primary);
  if (fallback !== undefined && !existsSync(primaryPath)) {
    const fallbackPath = resolveWithBase(projectRoot, fallback);
    if (existsSync(fallbackPath)) {
      return fallbackPath;
    }
  }
  return primaryPath;
}

/** Legacy global Antigravity config path retained only for migration checks. */
export function getLegacyAntigravityConfigPath(home: string): string {
  return resolveWithBase(home, ".gemini", "antigravity", "mcp_config.json");
}

export const CLIENT_REGISTRY: readonly McpClientSpec[] = [
  {
    id: "claude",
    label: "Claude Code",
    scope: "project",
    configPath: (projectRoot) => resolveWithBase(projectRoot, ".mcp.json"),
    format: "mcpServers",
    serverKey: "signalint",
    supportsCwd: true,
    marker: (projectRoot) => resolveMarker(projectRoot, ".mcp.json", ".claude"),
    addCommand: "claude mcp add signalint -- npx --no-install signalint-mcp",
    docsUrl: "https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/mcp",
  },
  {
    id: "cursor",
    label: "Cursor",
    scope: "project",
    configPath: (projectRoot) => resolveWithBase(projectRoot, ".cursor", "mcp.json"),
    format: "mcpServers",
    serverKey: "signalint",
    supportsCwd: true,
    marker: (projectRoot) => resolveWithBase(projectRoot, ".cursor"),
    docsUrl: "https://docs.cursor.com/context/model-context-protocol",
  },
  {
    id: "codex",
    label: "Codex CLI",
    scope: "project",
    configPath: (projectRoot) => resolveWithBase(projectRoot, ".codex", "config.toml"),
    format: "toml",
    serverKey: "signalint",
    supportsCwd: true,
    marker: (projectRoot) => resolveWithBase(projectRoot, ".codex"),
    addCommand: "codex mcp add signalint -- npx --no-install signalint-mcp",
    docsUrl: "https://github.com/openai/codex",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    scope: "project",
    configPath: (projectRoot) => resolveWithBase(projectRoot, ".agents", "mcp_config.json"),
    format: "mcpServers",
    serverKey: "signalint",
    supportsCwd: false,
    marker: (projectRoot) => resolveMarker(projectRoot, ".agents", "GEMINI.md"),
    docsUrl: "https://antigravity.google/docs/mcp",
  },
  {
    id: "vscode",
    label: "VS Code",
    scope: "project",
    configPath: (projectRoot) => resolveWithBase(projectRoot, ".vscode", "mcp.json"),
    format: "servers",
    serverKey: "signalint",
    supportsCwd: false,
    marker: (projectRoot) => resolveWithBase(projectRoot, ".vscode"),
    docsUrl: "https://code.visualstudio.com/docs/generative-ai/mcp",
  },
  {
    id: "claude",
    label: "Claude Code (user)",
    scope: "user",
    configPath: (_projectRoot, home) => resolveWithBase(home, ".claude.json"),
    format: "mcpServers",
    serverKey: "signalint",
    supportsCwd: false,
    marker: (projectRoot) => resolveWithBase(projectRoot, ".claude"),
    addCommand: "claude mcp add --scope user signalint -- npx --no-install signalint-mcp",
    docsUrl: "https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/mcp",
  },
  {
    id: "cursor",
    label: "Cursor (user)",
    scope: "user",
    configPath: (_projectRoot, home) => resolveWithBase(home, ".cursor", "mcp.json"),
    format: "mcpServers",
    serverKey: "signalint",
    supportsCwd: true,
    marker: (projectRoot) => resolveWithBase(projectRoot, ".cursor"),
    docsUrl: "https://docs.cursor.com/context/model-context-protocol",
  },
  {
    id: "codex",
    label: "Codex CLI (user)",
    scope: "user",
    configPath: (_projectRoot, home) => resolveWithBase(home, ".codex", "config.toml"),
    format: "toml",
    serverKey: "signalint",
    supportsCwd: true,
    marker: (projectRoot) => resolveWithBase(projectRoot, ".codex"),
    addCommand: "codex mcp add signalint -- npx --no-install signalint-mcp",
    docsUrl: "https://github.com/openai/codex",
  },
  {
    id: "antigravity",
    label: "Antigravity (user)",
    scope: "user",
    configPath: (_projectRoot, home) => resolveWithBase(home, ".gemini", "config", "mcp_config.json"),
    format: "mcpServers",
    serverKey: "signalint",
    supportsCwd: false,
    marker: (projectRoot) => resolveMarker(projectRoot, ".agents", "GEMINI.md"),
    docsUrl: "https://antigravity.google/docs/mcp",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    scope: "user",
    configPath: (_projectRoot, home) => resolveWithBase(home, ".codeium", "windsurf", "mcp_config.json"),
    format: "mcpServers",
    serverKey: "signalint",
    supportsCwd: false,
    marker: (projectRoot) => resolveWithBase(projectRoot, ".windsurf"),
    docsUrl: "https://docs.codeium.com/windsurf/mcp",
  },
  {
    id: "zed",
    label: "Zed",
    scope: "user",
    configPath: (_projectRoot, home) => resolveWithBase(home, ".config", "zed", "settings.json"),
    format: "zed",
    serverKey: "signalint",
    supportsCwd: false,
    marker: (projectRoot) => resolveWithBase(projectRoot, ".zed"),
    docsUrl: "https://zed.dev/docs/assistant/model-context-protocol",
  },
];
