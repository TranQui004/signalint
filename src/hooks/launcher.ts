import { getHookAdapter } from "./adapters/index.js";
import {
  type HookDecision,
  type HookEventType,
  type HookRuntime,
  isHookEventType,
  isHookRuntime,
  type NormalizedHookEvent,
} from "./event.js";
import { installHook, previewHookInstall } from "./install.js";
import { executeHookPolicy, type HookPolicyOptions } from "./policy.js";

export const HOOKS_USAGE =
  "Usage: signalint hooks <run|install|preview> [options]\n\n" +
  "Commands:\n" +
  "  run      Executes a hook adapter over stdin\n" +
  "           Options: --runtime <claude|cursor|codex|vscode> [--event <post_edit|stop>] [--fail-on-priority <N>]\n" +
  "  preview  Displays hook configuration without writing to disk\n" +
  "           Options: --runtime <claude|cursor|codex|vscode>\n" +
  "  install  Installs or merges hook definitions into host configuration\n" +
  "           Options: --runtime <claude|cursor|codex|vscode> [--confirm|--yes]\n";

export interface HookLauncherOptions {
  runtime: HookRuntime;
  eventType?: HookEventType | undefined;
  failOnPriority?: number | undefined;
  payload?: unknown | undefined;
  stdinStream?: NodeJS.ReadableStream | undefined;
  stdout?: ((text: string) => void) | undefined;
  cwd?: string | undefined;
  policyOptions?: Partial<HookPolicyOptions> | undefined;
}

export interface HookLauncherResult {
  exitCode: number;
  output: unknown;
  decision: HookDecision;
  event: NormalizedHookEvent;
}

interface ParsedRunArgs {
  runtime: HookRuntime;
  eventType?: HookEventType | undefined;
  failOnPriority?: number | undefined;
  payload?: unknown | undefined;
}

interface ParsedPreviewArgs {
  runtime: HookRuntime;
}

interface ParsedInstallArgs {
  runtime: HookRuntime;
  confirmed: boolean;
}

/** Reads input payload from a stream, falling back to empty object for TTY or empty streams. */
async function readPayloadFromStream(stream: NodeJS.ReadableStream): Promise<unknown> {
  const isTty = Boolean((stream as unknown as { isTTY?: boolean }).isTTY);
  if (isTty) {
    return {};
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`Failed to parse hook JSON payload from stdin: ${String(error)}`);
  }
}

/** Executes the full hook lifecycle: normalize event, evaluate policy, format native response, and output JSON. */
export async function runHookLauncher(options: HookLauncherOptions): Promise<HookLauncherResult> {
  const cwd = options.cwd ?? process.cwd();
  const adapter = getHookAdapter(options.runtime);

  let rawPayload = options.payload;
  if (rawPayload === undefined) {
    const stream = options.stdinStream ?? process.stdin;
    rawPayload = await readPayloadFromStream(stream);
  }

  const event = adapter.normalizeEvent(rawPayload, {
    defaultCwd: cwd,
    eventType: options.eventType,
  });

  const decision = await executeHookPolicy(event, {
    cwd,
    failOnPriority: options.failOnPriority,
    ...options.policyOptions,
  });

  const output = adapter.formatResponse(event, decision);
  const json = `${JSON.stringify(output, null, 2)}\n`;

  const writeOut = options.stdout ?? process.stdout.write.bind(process.stdout);
  writeOut(json);

  return {
    exitCode: 0,
    output,
    decision,
    event,
  };
}

/** Parses CLI arguments for `signalint hooks run`. */
function parseRunArgs(args: readonly string[]): ParsedRunArgs | undefined {
  let runtime: HookRuntime | undefined;
  let eventType: HookEventType | undefined;
  let failOnPriority: number | undefined;
  let payload: unknown | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--runtime") {
      const value = args[i + 1];
      if (!isHookRuntime(value)) {
        return undefined;
      }
      runtime = value;
      i += 1;
      continue;
    }
    if (arg === "--event") {
      const value = args[i + 1];
      if (!isHookEventType(value)) {
        return undefined;
      }
      eventType = value;
      i += 1;
      continue;
    }
    if (arg === "--fail-on-priority") {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value < 1) {
        return undefined;
      }
      failOnPriority = value;
      i += 1;
      continue;
    }
    if (arg === "--payload") {
      const value = args[i + 1];
      if (typeof value !== "string") {
        return undefined;
      }
      try {
        payload = JSON.parse(value);
      } catch {
        return undefined;
      }
      i += 1;
      continue;
    }
    return undefined;
  }

  if (runtime === undefined) {
    return undefined;
  }

  return { runtime, eventType, failOnPriority, payload };
}

/** Parses CLI arguments for `signalint hooks preview`. */
function parsePreviewArgs(args: readonly string[]): ParsedPreviewArgs | undefined {
  let runtime: HookRuntime | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--runtime") {
      const value = args[i + 1];
      if (!isHookRuntime(value)) {
        return undefined;
      }
      runtime = value;
      i += 1;
      continue;
    }
    return undefined;
  }

  if (runtime === undefined) {
    return undefined;
  }

  return { runtime };
}

/** Parses CLI arguments for `signalint hooks install`. */
function parseInstallArgs(args: readonly string[]): ParsedInstallArgs | undefined {
  let runtime: HookRuntime | undefined;
  let confirmed = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--runtime") {
      const value = args[i + 1];
      if (!isHookRuntime(value)) {
        return undefined;
      }
      runtime = value;
      i += 1;
      continue;
    }
    if (arg === "--confirm" || arg === "--yes" || arg === "-y") {
      confirmed = true;
      continue;
    }
    return undefined;
  }

  if (runtime === undefined) {
    return undefined;
  }

  return { runtime, confirmed };
}

/** Handles the `run` subcommand of the hooks CLI. */
async function handleHooksRun(args: readonly string[], cwd: string): Promise<number> {
  const parsed = parseRunArgs(args);
  if (parsed === undefined) {
    process.stderr.write(
      "Usage: signalint hooks run --runtime <claude|cursor|codex|vscode> [--event <post_edit|stop>] [--fail-on-priority <N>]\n",
    );
    return 2;
  }

  const result = await runHookLauncher({
    runtime: parsed.runtime,
    eventType: parsed.eventType,
    failOnPriority: parsed.failOnPriority,
    payload: parsed.payload,
    cwd,
  });

  return result.exitCode;
}

/** Handles the `preview` subcommand of the hooks CLI. */
async function handleHooksPreview(args: readonly string[], cwd: string): Promise<number> {
  const parsed = parsePreviewArgs(args);
  if (parsed === undefined) {
    process.stderr.write(
      "Usage: signalint hooks preview --runtime <claude|cursor|codex|vscode>\n",
    );
    return 2;
  }

  const preview = await previewHookInstall(parsed.runtime, cwd);
  process.stdout.write(preview.previewContent);
  return 0;
}

/** Handles the `install` subcommand of the hooks CLI. */
async function handleHooksInstall(args: readonly string[], cwd: string): Promise<number> {
  const parsed = parseInstallArgs(args);
  if (parsed === undefined) {
    process.stderr.write(
      "Usage: signalint hooks install --runtime <claude|cursor|codex|vscode> [--confirm|--yes]\n",
    );
    return 2;
  }

  const isTty = Boolean(process.stdin.isTTY);
  if (isTty && !parsed.confirmed) {
    process.stderr.write(
      "Hook installation requires explicit confirmation in interactive mode. Use --confirm or --yes.\n",
    );
    return 2;
  }

  const result = await installHook(parsed.runtime, cwd);
  const actionDesc =
    result.action === "already_installed"
      ? "already installed"
      : `${result.action}`;
  process.stdout.write(
    `[signalint] Hooks configuration for ${result.runtime} ${actionDesc} at ${result.targetPath}\n`,
  );
  return 0;
}

/** Dispatches the `hooks` CLI commands given arguments and project working directory. */
export async function runHooksCommand(
  args: readonly string[],
  cwd: string = process.cwd(),
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help" || subcommand === undefined) {
    process.stdout.write(HOOKS_USAGE);
    return 0;
  }

  if (subcommand === "run") {
    return await handleHooksRun(rest, cwd);
  }
  if (subcommand === "preview") {
    return await handleHooksPreview(rest, cwd);
  }
  if (subcommand === "install") {
    return await handleHooksInstall(rest, cwd);
  }

  process.stderr.write(`Unknown hooks subcommand: ${subcommand}\n${HOOKS_USAGE}`);
  return 2;
}
