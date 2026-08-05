/**
 * Wrappers around the **real execution** of a unit of durable work — a workflow turn, or a step
 * handler body. Distinct from {@link StepInterceptor} (`engine.use`), which only sees the in-process
 * `localStep` primitives (`ctx.now`, `ctx.sideEffect`, `ctx.task`'s dispatch step, saga
 * compensations): a user's `ctx.step` is ALWAYS dispatched, so its handler runs inside a transport
 * callback or a worker process where no engine is in scope at all.
 *
 * That is exactly why this registry is process-level rather than per-engine. `runStepHandler` is a
 * free function every transport shares, and a thin worker (`DurableModule` with a `connection` and
 * no `store`) holds no `WorkflowEngine` to hang a hook off. A per-engine registry could not reach
 * either, so the seam that covers every deployment shape has to sit above the engine.
 *
 * The intended consumer is an observability bridge (Telescope, OTel, a logger) that needs to
 * establish an ambient scope — an AsyncLocalStorage batch, a span — that the executing code records
 * into. It is deliberately NOT a transform point: see {@link runDurableExecution}.
 */

/** The unit of durable work a wrapper is being invoked around. */
export interface DurableExecution {
  /** `'workflow'` = one turn of a run's body; `'step'` = one step handler body. */
  readonly unit: 'workflow' | 'step';
  readonly runId: string;
  /** The workflow name. Present on a turn; a dispatched step task does not carry it on the wire. */
  readonly workflow: string | undefined;
  /** The step name, for `unit: 'step'`. Undefined for a turn. */
  readonly name: string | undefined;
  /** The step's logical position within the run, for `unit: 'step'`. */
  readonly seq: number | undefined;
  /** 1-based dispatch attempt, when the task carries one. */
  readonly attempt: number | undefined;
}

/**
 * Wraps one unit of durable work. Call `next()` to run the body (or the next wrapper). Whatever the
 * wrapper returns or throws is discarded — see {@link runDurableExecution} for why.
 */
export type DurableExecutionWrapper = (
  execution: DurableExecution,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/** First registered is outermost, matching `engine.use`'s onion order. */
const wrappers: DurableExecutionWrapper[] = [];

/**
 * Register a {@link DurableExecutionWrapper}. Returns an unregister function.
 *
 * Registering is the ONLY cost an unused hook imposes: with an empty registry
 * {@link runDurableExecution} returns the body's own promise without allocating a chain, so a host
 * that wires no observability pays nothing at all on the execution path.
 */
export function useDurableExecution(wrapper: DurableExecutionWrapper): () => void {
  wrappers.push(wrapper);
  return () => {
    const i = wrappers.indexOf(wrapper);
    if (i >= 0) wrappers.splice(i, 1);
  };
}

/** Drop every registered wrapper. For tests that must not leak a wrapper into the next file. */
export function clearDurableExecutionWrappers(): void {
  wrappers.length = 0;
}

/** Whether any wrapper is registered — lets a hot path skip building an execution descriptor. */
export function hasDurableExecutionWrappers(): boolean {
  return wrappers.length > 0;
}

/**
 * Run `body` inside every registered wrapper and settle with **the body's own outcome**.
 *
 * The wrappers' return values and throws are deliberately ignored. An observer that misbehaves —
 * returns early without calling `next()` is the one case we cannot paper over, but one that throws
 * *after* the body settled, or swallows the body's error and returns normally, is common enough in
 * telemetry code — must not be able to change what the workflow saw. A wrapper that turned a failed
 * step into a completed one would corrupt the run's history and its checkpoints, which is a far
 * worse failure than a missing trace. This is the same reasoning the bullmq/schedule Telescope
 * watchers apply when they re-throw the host's error rather than swallowing it, pushed down into
 * the seam so every wrapper gets it for free instead of having to remember.
 *
 * The one unrecoverable case is a wrapper that never calls `next()`: the body did not run, so there
 * is no outcome to return and we throw rather than invent one.
 */
export async function runDurableExecution<T>(
  execution: DurableExecution,
  body: () => Promise<T>,
): Promise<T> {
  if (wrappers.length === 0) return body();

  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const inner = async (): Promise<unknown> => {
    try {
      const value = await body();
      outcome = { ok: true, value };
      return value;
    } catch (error) {
      outcome = { ok: false, error };
      throw error;
    }
  };
  const chain = wrappers.reduceRight<() => Promise<unknown>>(
    (next, wrapper) => () => wrapper(execution, next),
    inner,
  );

  try {
    await chain();
  } catch (error) {
    // Only a throw from BEFORE the body ran can surface here — anything else is a wrapper's own
    // failure layered on top of a body that already settled, and the body wins below.
    if (outcome === undefined) throw error;
  }
  if (outcome === undefined) {
    throw new Error(
      'a durable execution wrapper returned without calling next() — the unit of work never ran',
    );
  }
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}
