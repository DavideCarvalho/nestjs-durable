import { SignalTimeoutError } from './errors';
import type { WorkflowCtx } from './interfaces';
import { CORE_ORIGIN } from './origin';
import type { RunTenant } from './tenancy';

/**
 * How `onEvent` triggers are coalesced into fewer runs (see `@Workflow({ debounce | batch })`).
 * `key` splits the coalescing per key: it receives each trigger's input (after the subscription's
 * `input` mapping) and triggers with the same key share one accumulator, so a burst for one key
 * starts one run without holding back or swallowing another key's.
 */
export type EventBatchConfig =
  | { mode: 'debounce'; windowMs: number; key?: ((input: unknown) => string) | undefined }
  | {
      mode: 'batch';
      maxSize: number;
      windowMs: number;
      key?: ((input: unknown) => string) | undefined;
    };

/** The tenant an accumulator run is started with (tenancy on): `null` = no tenant. */
export interface AccumulatorStartOptions {
  tenantId: string | null;
  tenantKind?: string | undefined;
}

/** The slice of the engine the accumulators need (so they stay a standalone module). */
export interface AccumulatorHost {
  register(
    name: string,
    version: string,
    fn: (ctx: WorkflowCtx, input: unknown) => Promise<unknown>,
    opts?: { origin?: string | undefined },
  ): void;
  signalWithStart(
    workflow: string,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
    opts?: AccumulatorStartOptions,
  ): Promise<{ runId: string }>;
}

/** `value` percent-encoded so it holds no `:`, `~` or other separator a run id gives meaning to. */
function escapeIdPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[~!'()*.]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The accumulator run id, which is also its signal token. Without a key it is the target's alone;
 * with one, the key is percent-encoded (`~` and the other characters `encodeURIComponent` keeps
 * included), so any string makes a safe id that cannot read as a continue-as-new suffix. With a
 * `tenant` (tenancy: a tenant's events), the id is that tenant's own, under a separate prefix with
 * the tenant id encoded the same way, so no key or target can name another tenant's accumulator.
 */
export function accumulatorRunId(target: string, key?: string, tenant?: string): string {
  const base = tenant === undefined ? '__evtacc__' : `__evtacc__@${escapeIdPart(tenant)}`;
  if (key === undefined) return `${base}:${target}`;
  return `${base}:${target}:${escapeIdPart(key)}`;
}

/**
 * The accumulator input: the target, its window, the key when coalescing per key, and the ids of the
 * events it already counted (see {@link ACCUMULATOR_SEEN_MAX}).
 */
interface AccumulatorInput {
  target: string;
  windowMs: number;
  maxSize?: number;
  key?: string;
  /** The tenant whose events this accumulator collects (tenancy), absent for the shared one. */
  tenant?: string;
  seen?: string[];
}

/**
 * How many routed event ids an accumulator remembers across bursts, so an event routed twice (a
 * lifecycle event published by two instances, or again by the sweep) counts once. The newest ids
 * are kept.
 */
export const ACCUMULATOR_SEEN_MAX = 1000;

/** A routed event that carries an id, as the accumulator receives it. */
interface RoutedEvent {
  __evtacc: 1;
  id: string;
  payload: unknown;
}

function isRoutedEvent(signal: unknown): signal is RoutedEvent {
  return (
    typeof signal === 'object' &&
    signal !== null &&
    (signal as Partial<RoutedEvent>).__evtacc === 1 &&
    typeof (signal as Partial<RoutedEvent>).id === 'string'
  );
}

/**
 * The events an accumulator has counted, by id. `fresh` answers whether a signal is new, recording
 * its id; a signal routed without an id is always new.
 */
class SeenEvents {
  private readonly ids: Set<string>;
  private readonly order: string[];

  constructor(seen: readonly string[] | undefined) {
    this.order = [...(seen ?? [])];
    this.ids = new Set(this.order);
  }

  fresh(signal: unknown): { fresh: true; payload: unknown } | { fresh: false } {
    if (!isRoutedEvent(signal)) return { fresh: true, payload: signal };
    if (this.ids.has(signal.id)) return { fresh: false };
    this.ids.add(signal.id);
    this.order.push(signal.id);
    return { fresh: true, payload: signal.payload };
  }

  /** The input to re-arm with: `input` plus the newest ids, when there are any. */
  rearm(input: AccumulatorInput): AccumulatorInput {
    const { seen: _seen, ...rest } = input;
    const seen = this.order.slice(-ACCUMULATOR_SEEN_MAX);
    return seen.length > 0 ? { ...rest, seen } : rest;
  }
}

const accToken = (input: Pick<AccumulatorInput, 'target' | 'key' | 'tenant'>): string =>
  accumulatorRunId(input.target, input.key, input.tenant);

/**
 * Built-in workflows that coalesce `onEvent` triggers. Each is a long-lived per-target accumulator
 * fed by `signalWithStart`: it collects payloads then starts the target once, and `continueAsNew`s to
 * re-arm for the next burst. Signal buffering keeps the re-arm race-free. Registers its runners on
 * construction.
 */
export class EventAccumulators {
  constructor(private readonly host: AccumulatorHost) {
    host.register('__evt_debounce', '1', (ctx, input) => this.debounce(ctx, input), {
      origin: CORE_ORIGIN,
    });
    host.register('__evt_batch', '1', (ctx, input) => this.batch(ctx, input), {
      origin: CORE_ORIGIN,
    });
  }

  /**
   * Route an `onEvent` payload into its target's debounce/batch accumulator: the target's one, or
   * with a `key`, the one for `String(config.key(payload))`. A `key` that throws rejects the route.
   * With `id`, the accumulator counts the event once however many times it is routed.
   *
   * `tenant` is the tenant the event belongs to when tenancy is on: a tenant gets its own
   * accumulator, stamped with it (so its target runs are too); `null` routes into the shared one,
   * stamped with no tenant. Undefined (tenancy off) starts the accumulator as before.
   */
  route(
    target: string,
    config: EventBatchConfig,
    payload: unknown,
    id?: string,
    tenant?: RunTenant | null,
  ): Promise<{ runId: string }> {
    const input: AccumulatorInput = {
      target,
      windowMs: config.windowMs,
      ...(config.mode === 'batch' ? { maxSize: config.maxSize } : {}),
      ...(config.key ? { key: String(config.key(payload)) } : {}),
      ...(tenant ? { tenant: tenant.id } : {}),
    };
    const workflow = config.mode === 'debounce' ? '__evt_debounce' : '__evt_batch';
    const token = accToken(input);
    const signal: unknown =
      id === undefined ? payload : ({ __evtacc: 1, id, payload } as RoutedEvent);
    const opts: AccumulatorStartOptions | undefined =
      tenant === undefined
        ? undefined
        : tenant === null
          ? { tenantId: null }
          : {
              tenantId: tenant.id,
              ...(tenant.kind !== undefined ? { tenantKind: tenant.kind } : {}),
            };
    return this.host.signalWithStart(workflow, input, token, { token, payload: signal }, opts);
  }

  /** Fire the target with the LAST payload once events have been quiet for `windowMs`. */
  private async debounce(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { target, windowMs } = input as AccumulatorInput;
    const token = accToken(input as AccumulatorInput);
    const seen = new SeenEvents((input as AccumulatorInput).seen);
    let first = seen.fresh(await ctx.waitForSignal(token)); // park for the first event of a burst
    while (!first.fresh) first = seen.fresh(await ctx.waitForSignal(token));
    let last = first.payload;
    for (;;) {
      try {
        // extend on each event
        const next = seen.fresh(await ctx.waitForSignal(token, { timeoutMs: windowMs }));
        if (next.fresh) last = next.payload;
      } catch (e) {
        if (e instanceof SignalTimeoutError) break; // quiet for `windowMs` → fire
        throw e; // WorkflowSuspended / ContinueAsNew etc. must propagate
      }
    }
    await ctx.startChild(target, last);
    return ctx.continueAsNew(seen.rearm(input as AccumulatorInput)); // re-arm
  }

  /** Fire the target with all payloads (`{ events }`) once `maxSize` or `windowMs` from the first. */
  private async batch(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { target, maxSize, windowMs } = input as AccumulatorInput & { maxSize: number };
    const token = accToken(input as AccumulatorInput);
    const seen = new SeenEvents((input as AccumulatorInput).seen);
    let first = seen.fresh(await ctx.waitForSignal(token)); // park for the first
    while (!first.fresh) first = seen.fresh(await ctx.waitForSignal(token));
    const events: unknown[] = [first.payload];
    const deadline = (await ctx.now()) + windowMs;
    while (events.length < maxSize) {
      const remaining = deadline - (await ctx.now());
      if (remaining <= 0) break;
      try {
        const next = seen.fresh(await ctx.waitForSignal(token, { timeoutMs: remaining }));
        if (next.fresh) events.push(next.payload);
      } catch (e) {
        if (e instanceof SignalTimeoutError) break; // window elapsed → fire what we have
        throw e; // WorkflowSuspended / ContinueAsNew etc. must propagate
      }
    }
    await ctx.startChild(target, { events });
    return ctx.continueAsNew(seen.rearm(input as AccumulatorInput)); // re-arm
  }
}
