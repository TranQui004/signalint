# Portable Verify-After-Change Hook Adapters

Signalint provides lightweight, native hook adapters for major AI coding assistants (**Claude Code**, **Cursor**, **Codex**, and **VS Code**).

Hooks automatically verify diagnostics after file edits and perform final whole-project validation when the agent stops, without creating competing autonomous agent loops.

---

## 1. Supported Host Runtimes

| Runtime | Post-Edit Hook Event | Agent Stop Event | Config File | Native Response Shape |
|---|---|---|---|---|
| **Claude Code** | `PostToolUse` (`Edit`, `Write`, `MultiEdit`) | `Stop` | `.claude/config.json` | `{ decision: "block" | "approve", reason?: string, additionalContext?: string }` |
| **Cursor** | `afterFileEdit` | `stop` | `.cursor/hooks.json` | `{ followup_message?: string, suggest_remediation?: boolean }` |
| **Codex** | `PostToolUse` | `Stop` | `.codex/hooks.json` | `{ continue: boolean, stop_reason?: string }` |
| **VS Code Agent** | `postToolUse` | `stop` | `.vscode/hooks.json` | `{ decision: "continue" | "retry", reason?: string }` |

---

## 2. Policy Engine & Safety Guarantees

Signalint owns diagnostic verification, while the host agent owns permissions, user interaction, and follow-up loops:

1. **Post-Edit Policy (`post_edit`):**
   - Triggers a fast scoped check via `checkFilesWithStats` on modified files only.
   - Emits a bounded context summary (top clusters, remaining issues up to cap, exact omission counts).
   - **Does not block** the agent by default unless `--fail-on-priority <N>` threshold is explicitly configured.

2. **Stop Policy (`stop`):**
   - Triggers a comprehensive project check (`collectProjectIssueResult`).
   - Blocks or requests agent follow-up if unresolved Priority <= 1 (syntax or fatal type) errors remain.
   - **Never reports clean on engine failure:** if an engine crashes or times out, the hook reports non-green (`status: "error"`).

3. **Strict Path Normalization:**
   - Rejects directory traversal (`..`), leading dashes (`-`), NUL characters (`\0`), out-of-boundary paths, and symlink escapes.
   - Ignores irrelevant non-code files (e.g. `README.md`, lockfiles, `.tmp` editor backups).

4. **Bounded Payloads:**
   - Raw compiler dumps are never echoed into agent prompt context. Payloads format bounded summaries with exact omission counters to prevent context window explosion.

---

## 3. CLI Management

Signalint includes a dedicated `hooks` CLI command:

### Preview Hook Configuration (Dry Run)
Inspect the generated hook configuration without writing to disk:
```sh
npx signalint hooks preview --runtime claude
npx signalint hooks preview --runtime cursor
npx signalint hooks preview --runtime codex
npx signalint hooks preview --runtime vscode
```

### Install Hooks (Non-Destructive Merge)
Merge Signalint hook entries into host configuration files:
```sh
npx signalint hooks install --runtime claude --confirm
npx signalint hooks install --runtime cursor --confirm
```
- **Preserves existing settings:** Existing user configuration, MCP server registrations, and unrelated custom hooks are retained intact.
- **Project-scoped:** Hooks are installed strictly within the current repository boundary.

### Execute Hooks Manually
Invoke the hook launcher directly (standard in host hook scripts):
```sh
# Via stdin payload:
cat event.json | npx signalint hooks run --runtime claude

# Via CLI argument payload:
npx signalint hooks run --runtime claude --payload '{"hook_event_name":"PostToolUse","tool_input":{"file_path":"src/index.ts"}}'
```
