import { normalizeIssueMessage, type NormalizedIssue } from "../schema.js";
import type { DiagnosticSnapshot } from "./snapshots.js";

export interface DiagnosticDelta {
  baselineCheckId: string;
  currentCheckId: string;
  errorsIntroduced: number;
  errorsResolved: number;
  netDelta: number;
  introducedIssues: NormalizedIssue[];
  resolvedIssues: NormalizedIssue[];
  unchangedIssues: NormalizedIssue[];
  nextStep: string;
}

/** Computes a deterministic diagnostic delta between a baseline and current snapshot. */
export function computeDiagnosticDelta(
  baselineSnapshot: DiagnosticSnapshot,
  currentSnapshot: DiagnosticSnapshot,
): DiagnosticDelta {
  const baselineIssues = baselineSnapshot.issues;
  const currentIssues = currentSnapshot.issues;

  const unchangedIssues: NormalizedIssue[] = [];
  const unmatchedBaseline: NormalizedIssue[] = [];
  const unmatchedCurrent: NormalizedIssue[] = [];

  // Pass 1: exact issueId match
  const baselineById = new Map<string, NormalizedIssue[]>();
  for (const issue of baselineIssues) {
    const list = baselineById.get(issue.issueId) ?? [];
    list.push(issue);
    baselineById.set(issue.issueId, list);
  }

  for (const current of currentIssues) {
    const matchedList = baselineById.get(current.issueId);
    if (matchedList && matchedList.length > 0) {
      matchedList.shift();
      unchangedIssues.push(current);
    } else {
      unmatchedCurrent.push(current);
    }
  }

  for (const remaining of baselineById.values()) {
    unmatchedBaseline.push(...remaining);
  }

  // Pass 2: semantic identity match resilient to line shifts
  const makeSemanticKey = (issue: NormalizedIssue): string =>
    `${issue.file}\0${issue.rule}\0${normalizeIssueMessage(issue.message)}\0${issue.severity}`;

  const baselineSemanticGroups = new Map<string, NormalizedIssue[]>();
  for (const issue of unmatchedBaseline) {
    const key = makeSemanticKey(issue);
    const list = baselineSemanticGroups.get(key) ?? [];
    list.push(issue);
    baselineSemanticGroups.set(key, list);
  }

  const introducedIssues: NormalizedIssue[] = [];

  for (const current of unmatchedCurrent) {
    const key = makeSemanticKey(current);
    const candidateBaselineList = baselineSemanticGroups.get(key);
    if (candidateBaselineList && candidateBaselineList.length > 0) {
      let bestIdx = 0;
      const firstCandidate = candidateBaselineList[0];
      if (firstCandidate !== undefined) {
        let minDiff = Math.abs(firstCandidate.line - current.line);
        for (let i = 1; i < candidateBaselineList.length; i++) {
          const candidate = candidateBaselineList[i];
          if (candidate !== undefined) {
            const diff = Math.abs(candidate.line - current.line);
            if (diff < minDiff) {
              minDiff = diff;
              bestIdx = i;
            }
          }
        }
        candidateBaselineList.splice(bestIdx, 1);
        unchangedIssues.push(current);
      } else {
        introducedIssues.push(current);
      }
    } else {
      introducedIssues.push(current);
    }
  }

  const resolvedIssues: NormalizedIssue[] = [];
  for (const remaining of baselineSemanticGroups.values()) {
    resolvedIssues.push(...remaining);
  }

  const errorsIntroduced = introducedIssues.filter((i) => i.severity === "error").length;
  const errorsResolved = resolvedIssues.filter((i) => i.severity === "error").length;
  const netDelta = errorsIntroduced - errorsResolved;

  const currentErrors = currentIssues.filter((i) => i.severity === "error").length;
  let nextStep: string;
  if (errorsIntroduced > 0) {
    nextStep = `${errorsIntroduced} new error(s) introduced by changes. Revert or resolve before continuing.`;
  } else if (errorsResolved > 0) {
    if (currentErrors === 0) {
      nextStep = "All baseline errors resolved. Clean check.";
    } else {
      nextStep = `${errorsResolved} error(s) resolved; ${currentErrors} error(s) remaining.`;
    }
  } else if (currentErrors === 0) {
    nextStep = "Clean: 0 errors detected.";
  } else {
    nextStep = `${currentErrors} baseline error(s) remain unchanged.`;
  }

  return {
    baselineCheckId: baselineSnapshot.checkId,
    currentCheckId: currentSnapshot.checkId,
    errorsIntroduced,
    errorsResolved,
    netDelta,
    introducedIssues,
    resolvedIssues,
    unchangedIssues,
    nextStep,
  };
}
