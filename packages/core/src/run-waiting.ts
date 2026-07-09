import { eventNameOf } from './events';
import type { RunWaiting, SignalWaiter, WorkflowRun } from './interfaces';

// Waiter-token prefixes the engine stamps (see `workflow-ctx.ts`): a webhook mints `wh:<runId>:<seq>`,
// an awaited child parks on `child:<id>`, a named event on `event:<b64 name>:…`. A plain
// `ctx.waitForSignal(name)` uses `name` verbatim as the token, so an unrecognised token IS the signal
// name.
const WEBHOOK_PREFIX = 'wh:';
const CHILD_PREFIX = 'child:';
const EVENT_PREFIX = 'event:';

/**
 * Resolve WHAT a suspended run is parked on from the token of the {@link SignalWaiter} it registered.
 * The token prefix carries the kind — no extra store lookup and no new persisted field. Used by the
 * store-backed run gateway to stamp {@link RunWaiting} onto each listed run so the dashboard can name
 * the wait in a row without fetching that run's timeline.
 */
export function classifyWaiterToken(token: string): RunWaiting {
  if (token.startsWith(WEBHOOK_PREFIX)) return { on: 'webhook', name: token };
  if (token.startsWith(CHILD_PREFIX))
    return { on: 'child', name: token.slice(CHILD_PREFIX.length) };
  if (token.startsWith(EVENT_PREFIX)) return { on: 'signal', name: eventNameOf(token) };
  return { on: 'signal', name: token };
}

/**
 * Resolve a suspended run's {@link RunWaiting} from the pending signal waiters (indexed by `runId`).
 * Event-only by design (see {@link RunWaiting}): a `waitForSignal`/`waitForEvent`/webhook/awaited-child
 * suspend registers a waiter and gets named here; every other suspend (a bare `ctx.sleep`, an in-flight
 * remote step, a reconcile-parked orphan) returns `undefined`, so the client layers its own display
 * state (no-worker, singleton, running) on top — none of which can be told apart from `wakeAt` alone.
 */
export function resolveRunWaiting(
  run: WorkflowRun,
  waiterByRun: ReadonlyMap<string, SignalWaiter>,
): RunWaiting | undefined {
  if (run.status !== 'suspended') return undefined;
  const waiter = waiterByRun.get(run.id);
  return waiter ? classifyWaiterToken(waiter.token) : undefined;
}

/** Index signal waiters by `runId`, keeping the first seen per run (a run parks on one waiter at a
 *  time in the sequential case; the earliest is the one it's blocked on). */
export function indexWaitersByRun(waiters: readonly SignalWaiter[]): Map<string, SignalWaiter> {
  const byRun = new Map<string, SignalWaiter>();
  for (const w of waiters) if (!byRun.has(w.runId)) byRun.set(w.runId, w);
  return byRun;
}
