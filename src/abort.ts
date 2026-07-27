export interface LinkedAbortController {
  controller: AbortController;
  dispose: () => void;
}

/** Creates a child controller that aborts with its optional parent signal. */
export function createLinkedAbortController(
  parent?: AbortSignal,
): LinkedAbortController {
  const controller = new AbortController();
  if (parent === undefined) {
    return { controller, dispose: () => undefined };
  }
  const abort = (): void => controller.abort(parent.reason);
  if (parent.aborted) {
    abort();
  } else {
    parent.addEventListener("abort", abort, { once: true });
  }
  return {
    controller,
    dispose: () => parent.removeEventListener("abort", abort),
  };
}
