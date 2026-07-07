import { currentWorkflowCtx } from './ambient-ctx';
import type { StartOptions } from './engine';
import { FatalError } from './errors';
import type { RunResult } from './interfaces';
import {
  type WorkflowClass,
  type WorkflowInputOf,
  type WorkflowOutputOf,
  workflowName,
} from './workflow-ref';

/**
 * What the class-first statics need from whoever registered the workflow class: the engine, or a
 * store-less start facade (a tenant's `DurableStartClient`). `waitForRun` is optional — a facade
 * without a store cannot wait, so `execute` outside a workflow throws a clear error there.
 */
export interface WorkflowStartClient {
  start(workflow: string, input: unknown, runId: string, opts?: StartOptions): Promise<RunResult>;
  waitForRun?(
    runId: string,
    opts?: { timeoutMs?: number; until?: 'settled' | 'terminal' },
  ): Promise<RunResult>;
}

/**
 * Per-process class → start-client bindings, written by the registrar at boot. On `globalThis`
 * under a `Symbol.for` key for the same duplicate-copy reason as the ambient context: every copy of
 * core in the tree must read the same map. A WeakMap so a torn-down module doesn't pin its classes.
 */
const BINDINGS_KEY = Symbol.for('nestjs-durable:workflow-class-bindings');

type GlobalWithBindings = typeof globalThis & {
  // biome-ignore lint/complexity/noBannedTypes: keyed by class constructors
  [BINDINGS_KEY]?: WeakMap<Function, WorkflowStartClient>;
};

const globalRef = globalThis as GlobalWithBindings;
if (!globalRef[BINDINGS_KEY]) {
  globalRef[BINDINGS_KEY] = new WeakMap();
}
const bindings = globalRef[BINDINGS_KEY];

/**
 * Bind a `@Workflow` class to the client that can start it — called by the registrar for every
 * discovered workflow at boot. This is what lets `MyWorkflow.start()` resolve THE engine that
 * registered it, with no global engine singleton (two engines in one process each bind their own
 * classes).
 */
// biome-ignore lint/complexity/noBannedTypes: keyed by class constructors
export function bindWorkflowClass(ctor: Function, client: WorkflowStartClient): void {
  bindings.set(ctor, client);
}

function clientOf(ctor: WorkflowClass): WorkflowStartClient {
  const client = bindings.get(ctor);
  if (!client) {
    throw new Error(
      `${workflowName(ctor)} is not bound to a durable engine — the class-first statics only work after the module that registers this workflow has booted (or, in a store-less tenant worker, use the injected WorkflowService/engine facade instead).`,
    );
  }
  return client;
}

/**
 * Optional base class giving a `@Workflow` a **class-first API** — start it from anywhere without
 * injecting the engine or `WorkflowService`:
 *
 * ```ts
 * @Workflow({ name: 'checkout', version: '1' })
 * export class CheckoutWorkflow extends DurableWorkflow {
 *   async run(ctx: WorkflowCtx, order: Order) { ... }
 * }
 *
 * const { runId } = await CheckoutWorkflow.start(order);   // fire-and-forget, typed input
 * const result = await CheckoutWorkflow.execute(order);    // run-and-await, typed output
 * ```
 *
 * Each method means the same thing everywhere; only the mechanism adapts to where you call it:
 *
 * - {@link DurableWorkflow.start | `start`} — **fire-and-forget**. Outside a workflow it is exactly
 *   `engine.start` (enqueue, return `{ runId, status }` immediately). Inside a workflow body it
 *   becomes `ctx.startChild` — checkpointed, replay-safe, parent-linked — same contract.
 * - {@link DurableWorkflow.execute | `execute`} — **run-and-await the typed output**. Inside a
 *   workflow it is `ctx.child` (the parent suspends with zero compute and resumes with the result).
 *   Outside it starts the run and waits until it settles terminally, resolving the output or
 *   throwing `FatalError` when the run failed/cancelled/dead.
 *
 * Inside-ness is detected via the ambient workflow context the engine installs around every body
 * execution (see `ambient-ctx.ts`). A `@Step` handler runs on a worker, off the body's path — the
 * statics there start a TOP-LEVEL run, which is correct: a handler is not the workflow body.
 */
export class DurableWorkflow {
  /**
   * Fire-and-forget start — `engine.start` outside a workflow, `ctx.startChild` (parent-linked)
   * inside one. `opts.id` pins the run id (outside) / child id (inside) for idempotent starts.
   */
  static async start<C extends WorkflowClass>(
    this: C,
    input: WorkflowInputOf<C>,
    opts?: { id?: string } & StartOptions,
  ): Promise<RunResult> {
    // biome-ignore lint/complexity/noThisInStatic: the polymorphic `this` IS the subclass being started — the class name would break every subclass
    const cls = this;
    const ctx = currentWorkflowCtx();
    if (ctx) {
      const runId = await ctx.startChild(cls, input, opts?.id);
      return { runId, status: 'pending' };
    }
    const runId = opts?.id ?? globalThis.crypto.randomUUID();
    return clientOf(cls).start(workflowName(cls), input, runId, opts);
  }

  /**
   * Run-and-await the typed output — `ctx.child` inside a workflow (suspends the parent, zero
   * compute); outside, starts the run and waits until it settles terminally. Throws `FatalError`
   * when the run does not complete. `opts.timeoutMs` bounds the OUTSIDE wait only (inside, a
   * suspended parent costs nothing — bound the child itself with `executionTimeout` instead).
   */
  static async execute<C extends WorkflowClass>(
    this: C,
    input: WorkflowInputOf<C>,
    opts?: { id?: string; timeoutMs?: number } & StartOptions,
  ): Promise<WorkflowOutputOf<C>> {
    // biome-ignore lint/complexity/noThisInStatic: the polymorphic `this` IS the subclass being run — the class name would break every subclass
    const cls = this;
    const ctx = currentWorkflowCtx();
    if (ctx) return ctx.child(cls, input, opts?.id);
    const client = clientOf(cls);
    if (!client.waitForRun) {
      throw new FatalError(
        `${workflowName(cls)}.execute() outside a workflow needs a store-backed engine to await the result — this class is bound to a store-less start facade (tenant worker). Use ${workflowName(cls)}.start() and observe the run instead.`,
        'execute_unsupported',
      );
    }
    const runId = opts?.id ?? globalThis.crypto.randomUUID();
    await client.start(workflowName(cls), input, runId, opts);
    const settled = await client.waitForRun(runId, {
      ...(opts?.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
      until: 'terminal',
    });
    if (settled.status === 'completed') return settled.output as WorkflowOutputOf<C>;
    const detail = settled.error ? `: ${settled.error.message}` : '';
    throw new FatalError(
      `${workflowName(cls)} run ${runId} settled ${settled.status}${detail}`,
      settled.error?.code ?? 'execute_failed',
    );
  }
}
