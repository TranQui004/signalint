import type {
  EngineStatus,
  EngineStatuses,
  IssueEngine,
} from "./schema.js";

export interface EngineTask<T> {
  enabled: boolean;
  engine: IssueEngine;
  run: () => Promise<T>;
}

export interface EngineFanoutResult<T> {
  engines: EngineStatuses;
  results: T[];
}

/** Runs enabled engine tasks independently and preserves every fulfilled result. */
export async function settleEngineTasks<T>(
  tasks: readonly EngineTask<T>[],
): Promise<EngineFanoutResult<T>> {
  const settlements = await Promise.allSettled(
    tasks.map(async (task) => task.enabled ? await task.run() : undefined),
  );
  const engines = createDisabledStatuses();
  const results: T[] = [];

  for (const [index, settlement] of settlements.entries()) {
    const task = tasks[index];
    if (task === undefined) {
      throw new Error("Engine settlement did not have a matching task.");
    }
    if (!task.enabled) {
      continue;
    }
    if (settlement.status === "fulfilled") {
      if (settlement.value !== undefined) {
        results.push(settlement.value);
      }
      engines[task.engine] = { status: "ok" };
      continue;
    }
    logEngineFailure(task.engine, settlement.reason);
    engines[task.engine] = createErrorStatus(settlement.reason);
  }

  return { engines, results };
}

/** Converts enabled flags into statuses for a check that has no paths to run. */
export function createIdleEngineStatuses(
  enabled: Readonly<Record<IssueEngine, boolean>>,
): EngineStatuses {
  return {
    oxlint: { status: enabled.oxlint ? "ok" : "disabled" },
    tsc: { status: enabled.tsc ? "ok" : "disabled" },
    biome: { status: enabled.biome ? "ok" : "disabled" },
  };
}

function createDisabledStatuses(): EngineStatuses {
  return {
    oxlint: { status: "disabled" },
    tsc: { status: "disabled" },
    biome: { status: "disabled" },
  };
}

function createErrorStatus(error: unknown): EngineStatus {
  const message = error instanceof Error ? error.message : String(error);
  return { status: "error", message };
}

function logEngineFailure(engine: IssueEngine, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[signalint] engine=${engine} check failed: ${detail}\n`);
}
