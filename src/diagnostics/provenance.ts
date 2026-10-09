/**
 * Defines source provenance models for compiler, linter, LSP, and editor diagnostics.
 */

export type DiagnosticSourceKind = "compiler" | "linter" | "lsp" | "editor";

export type DiagnosticEngine =
  | "oxlint"
  | "tsc"
  | "biome"
  | "eslint"
  | "external-lsp"
  | "vscode";

export interface DiagnosticSource {
  kind: DiagnosticSourceKind;
  engine: DiagnosticEngine;
  serverName?: string;
  timestamp: number;
}

/** Creates a source provenance record tagged with the current timestamp. */
export function createDiagnosticSource(
  kind: DiagnosticSourceKind,
  engine: DiagnosticEngine,
  serverName?: string,
  timestamp: number = Date.now(),
): DiagnosticSource {
  return {
    kind,
    engine,
    ...(serverName !== undefined ? { serverName } : {}),
    timestamp,
  };
}

/** Infers diagnostic source kind and engine from an external source or server name string. */
export function inferDiagnosticSource(
  source?: string,
  serverName?: string,
): DiagnosticSource {
  const normSource = source?.toLowerCase().trim();
  const normServer = serverName?.toLowerCase().trim();

  let engine: DiagnosticEngine = "external-lsp";
  let kind: DiagnosticSourceKind = "lsp";

  if (normSource === "tsc" || normSource === "typescript") {
    engine = "tsc";
    kind = "compiler";
  } else if (normSource === "oxlint") {
    engine = "oxlint";
    kind = "linter";
  } else if (normSource === "eslint") {
    engine = "eslint";
    kind = "linter";
  } else if (normSource === "biome") {
    engine = "biome";
    kind = "linter";
  } else if (normSource === "vscode" || normServer === "vscode") {
    engine = "vscode";
    kind = "editor";
  }

  return {
    kind,
    engine,
    ...(serverName !== undefined && serverName !== "" ? { serverName } : {}),
    timestamp: Date.now(),
  };
}
