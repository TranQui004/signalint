import { fileURLToPath } from "node:url";

import { validateHookPath } from "../hooks/paths.js";
import {
  createIssueId,
  normalizeIssueMessage,
  type IssueEngine,
  type IssueSeverity,
  type NormalizedIssue,
} from "../schema.js";
import type { DiagnosticSourceKind } from "./provenance.js";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface RawLspDiagnostic {
  file?: string | undefined;
  uri?: string | undefined;
  range: LspRange;
  severity?: number | undefined;
  code?: string | number | undefined;
  source?: string | undefined;
  message: string;
}

export interface NormalizeLspOptions {
  projectRoot: string;
  file?: string | undefined;
  uri?: string | undefined;
  source?: string | undefined;
  serverName?: string | undefined;
  engine?: IssueEngine | undefined;
  sourceKind?: DiagnosticSourceKind | undefined;
  defaultSeverity?: IssueSeverity | undefined;
  ignoreInfoAndHints?: boolean | undefined;
}

/** Decodes a file:// URI or returns the path directly, handling cross-platform Windows/POSIX drive representations. */
export function decodeFileUri(uriOrPath: string): string {
  if (!uriOrPath.startsWith("file://")) {
    return uriOrPath;
  }
  try {
    const res = fileURLToPath(uriOrPath);
    if (process.platform !== "win32" && /^\/[a-zA-Z]:\//.test(res)) {
      return res.slice(1);
    }
    return res;
  } catch {
    const pathname = uriOrPath.slice("file://".length);
    const decoded = decodeURIComponent(pathname);
    if (/^\/[a-zA-Z]:[\\/]/.test(decoded)) {
      return decoded.slice(1);
    }
    return decoded;
  }
}

/** Resolves the stable rule name from LSP source and code attributes. */
export function formatLspRule(source?: string, code?: string | number): string {
  const codeStr = code !== undefined && code !== null ? String(code).trim() : "";
  const srcStr = source?.trim() ?? "";

  if (srcStr !== "" && codeStr !== "") {
    return `${srcStr}(${codeStr})`;
  }
  if (codeStr !== "") {
    return codeStr;
  }
  if (srcStr !== "") {
    return srcStr;
  }
  return "lsp";
}

/** Normalizes a raw LSP diagnostic into Signalint's unified schema with 1-based coordinates and project containment. */
export function normalizeLspDiagnostic(
  raw: RawLspDiagnostic,
  options: NormalizeLspOptions,
): NormalizedIssue | null {
  if (options.ignoreInfoAndHints && (raw.severity === 3 || raw.severity === 4)) {
    return null;
  }

  const rawTarget = raw.file ?? raw.uri ?? options.file ?? options.uri;
  if (!rawTarget || rawTarget.trim() === "") {
    throw new Error("LSP diagnostic is missing required file target.");
  }

  const decodedPath = decodeFileUri(rawTarget.trim());
  const normalizedFile = validateHookPath(decodedPath, options.projectRoot);

  const line = Math.max(1, (raw.range?.start?.line ?? 0) + 1);
  const col = Math.max(1, (raw.range?.start?.character ?? 0) + 1);

  const severity: IssueSeverity =
    raw.severity === 1
      ? "error"
      : raw.severity === 2
        ? "warning"
        : raw.severity === 3 || raw.severity === 4
          ? "warning"
          : (options.defaultSeverity ?? "error");

  const effectiveSource = raw.source ?? options.source ?? options.serverName;
  const rule = formatLspRule(effectiveSource, raw.code);
  const normalizedMessage = normalizeIssueMessage(raw.message ?? "");
  const issueId = createIssueId(normalizedFile, rule, line, normalizedMessage);

  return {
    issueId,
    file: normalizedFile,
    line,
    col,
    engine: options.engine ?? "external-lsp",
    rule,
    severity,
    message: normalizedMessage,
    fixable: false,
    ...(options.serverName ? { serverName: options.serverName } : {}),
    sourceKind: options.sourceKind ?? "lsp",
  };
}
