import { SignalTimeoutError } from './errors';
import type { WorkflowCtx } from './interfaces';
import { CORE_ORIGIN } from './origin';

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
  ): Promise<{ runId: string }>;
}

/**
 * The accumulator run id, which is also its signal token. Without a key it is the target's alone;
 * with one, the key is percent-encoded (`~` and the other characters `encodeURIComponent` keeps
 * included), so any string makes a safe id that cannot read as a continue-as-new suffix.
 */
export function accumulatorRunId(target: string, key?: string): string {
  if (key === undefined) return `__evtacc__:${target}`;
  const escaped = encodeURIComponent(key).replace(
    /[~!'()*.]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `__evtacc__:${target}:${escaped}`;
}

/** The accumulator input: the target, its window, and the key when coalescing per key. */
interface AccumulatorInput {
  target: string;
  windowMs: number;
  maxSize?: number;
  key?: string;
}

const accToken = (input: Pick<AccumulatorInput, 'target' | 'key'>): string =>
  accumulatorRunId(input.target, input.key);

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
   */
  route(target: string, config: EventBatchConfig, payload: unknown): Promise<{ runId: string }> {
    const input: AccumulatorInput = {
      target,
      windowMs: config.windowMs,
      ...(config.mode === 'batch' ? { maxSize: config.maxSize } : {}),
      ...(config.key ? { key: String(config.key(payload)) } : {}),
    };
    const workflow = config.mode === 'debounce' ? '__evt_debounce' : '__evt_batch';
    const token = accToken(input);
    return this.host.signalWithStart(workflow, input, token, { token, payload });
  }

  /** Fire the target with the LAST payload once events have been quiet for `windowMs`. */
  private async debounce(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { target, windowMs } = input as AccumulatorInput;
    const token = accToken(input as AccumulatorInput);
    let last = await ctx.waitForSignal(token); // park for the first event of a burst
    for (;;) {
      try {
        last = await ctx.waitForSignal(token, { timeoutMs: windowMs }); // extend on each event
      } catch (e) {
        if (e instanceof SignalTimeoutError) break; // quiet for `windowMs` → fire
        throw e; // WorkflowSuspended / ContinueAsNew etc. must propagate
      }
    }
    await ctx.startChild(target, last);
    return ctx.continueAsNew(input); // re-arm
  }

  /** Fire the target with all payloads (`{ events }`) once `maxSize` or `windowMs` from the first. */
  private async batch(ctx: WorkflowCtx, input: unknown): Promise<unknown> {
    const { target, maxSize, windowMs } = input as AccumulatorInput & { maxSize: number };
    const token = accToken(input as AccumulatorInput);
    const events: unknown[] = [await ctx.waitForSignal(token)]; // park for the first
    const deadline = (await ctx.now()) + windowMs;
    while (events.length < maxSize) {
      const remaining = deadline - (await ctx.now());
      if (remaining <= 0) break;
      try {
        events.push(await ctx.waitForSignal(token, { timeoutMs: remaining }));
      } catch (e) {
        if (e instanceof SignalTimeoutError) break; // window elapsed → fire what we have
        throw e; // WorkflowSuspended / ContinueAsNew etc. must propagate
      }
    }
    await ctx.startChild(target, { events });
    return ctx.continueAsNew(input); // re-arm
  }
}
