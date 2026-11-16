import { createHash } from 'node:crypto';
import type { EngineEvent } from './interfaces';

/**
 * The trace id of `runId`: 32 lowercase hex, never all zeros, the same in every process. A control
 * plane records a tenant run's lifecycle events in this trace, and a tenant pod running the run's
 * steps under Telescope records the steps' own work in it too (the Telescope integration derives the
 * same id), so the two views join on `trace:<id>` without either side calling the other.
 */
export function runTraceId(runId: string): string {
  const hex = createHash('sha256').update(`durable:run:${runId}`).digest('hex').slice(0, 32);
  return /^0+$/.test(hex) ? `${hex.slice(0, 31)}1` : hex;
}

/**
 * How an observer on a control plane finds the tenant app of a run. A tenant's runs live in the
 * partition its token verified to (`run.namespace`); `run.*` events carry it, `step.*` events do
 * not, so the observer remembers it per run and, for a run it has seen no event of yet (a run
 * resumed after a restart, another pod's run), reads it once.
 */
export interface RunAppAttribution {
  /** The namespace (tenant partition) of `runId`, or `undefined` when the run is unknown. */
  namespaceOf(runId: string): Promise<string | undefined>;
  /**
   * The control plane's own namespaces: runs in these are its own, not a tenant's, and get no app.
   * `'default'` and an absent namespace are always the control plane's.
   */
  own?: readonly string[] | undefined;
  /** How many run → app answers to keep (oldest dropped first). Default 10,000. */
  cacheSize?: number | undefined;
  /**
   * How long one read may take before the event is forwarded unattributed (the run's next event
   * reads again). Default 5,000 ms.
   */
  lookupTimeoutMs?: number | undefined;
}

/** The tenant app of a run in `namespace`, or `undefined` for the control plane's own runs. */
export function tenantAppOf(
  namespace: string | undefined,
  own: ReadonlySet<string> | readonly string[] = [],
): string | undefined {
  if (namespace === undefined || namespace === '' || namespace === 'default') return undefined;
  const mine = Array.isArray(own) ? own.includes(namespace) : (own as Set<string>).has(namespace);
  return mine ? undefined : namespace;
}

/** An engine event a control plane attributed to a tenant app. */
export type AttributedEngineEvent = EngineEvent & { app?: string | undefined };

/** A namespace read that threw or timed out. */
const FAILED: unique symbol = Symbol('failed');

/**
 * Remembers which tenant app each run belongs to and stamps it on that run's events, keeping their
 * order. An event whose run is not known yet waits for one read; that run's later events wait behind
 * it (a run's `step.completed` is never forwarded before its `step.started`), other runs' do not. A
 * read that fails or takes longer than `lookupTimeoutMs` forwards the event unattributed and is not
 * remembered, so the run's next event reads again.
 *
 * A tenant's event is forwarded with `app` set and, when the engine left it off (step events), its
 * partition as `namespace`. The control plane's own runs are forwarded unchanged.
 */
export class RunAppStamper {
  readonly #lookup: (runId: string) => Promise<string | undefined>;
  readonly #own: ReadonlySet<string>;
  readonly #max: number;
  readonly #timeoutMs: number;
  /** runId → app (`null`: the control plane's own run). */
  readonly #apps = new Map<string, string | null>();
  /** runId → the last queued event of that run, while one is waiting on a read. */
  readonly #tails = new Map<string, Promise<void>>();

  constructor(options: RunAppAttribution) {
    this.#lookup = (runId) => options.namespaceOf(runId);
    this.#own = new Set(options.own ?? []);
    this.#max = Math.max(1, options.cacheSize ?? 10_000);
    this.#timeoutMs = Math.max(1, options.lookupTimeoutMs ?? 5_000);
  }

  /** Call `forward` with `event` stamped with its app (when it has one), now or once it is known. */
  stamp(event: EngineEvent, forward: (event: AttributedEngineEvent) => void): void {
    const runId = event.runId;
    const tail = this.#tails.get(runId);
    if (tail === undefined) {
      const known = this.#known(event);
      if (known !== undefined) {
        this.#forward(event, known, forward);
        return;
      }
    }
    const next = (tail ?? Promise.resolve()).then(async () => {
      try {
        let app = this.#known(event);
        if (app === undefined) {
          const namespace = await this.#read(runId);
          if (namespace === FAILED) {
            app = null; // not remembered: the run's next event reads again
          } else {
            app = tenantAppOf(namespace, this.#own) ?? null;
            this.#remember(runId, app);
          }
        }
        this.#forward(event, app, forward);
      } catch {
        // Recording must never break the engine, nor stall the events behind this one.
      }
    });
    this.#tails.set(runId, next);
    void next.then(() => {
      if (this.#tails.get(runId) === next) this.#tails.delete(runId);
    });
  }

  #forward(
    event: EngineEvent,
    app: string | null,
    forward: (event: AttributedEngineEvent) => void,
  ): void {
    try {
      forward(this.#with(event, app));
    } finally {
      // A settled run emits nothing more: forget it.
      if (event.type === 'run.completed' || event.type === 'run.failed') {
        this.#apps.delete(event.runId);
      }
    }
  }

  /** The run's namespace, or {@link FAILED} when the read threw or did not answer in time. */
  async #read(runId: string): Promise<string | undefined | typeof FAILED> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof FAILED>((resolve) => {
      timer = setTimeout(() => resolve(FAILED), this.#timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => this.#lookup(runId))
          .catch((): typeof FAILED => FAILED),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The app of `event`'s run when it is known without a read (`null`: no app). */
  #known(event: EngineEvent): string | null | undefined {
    if (event.namespace !== undefined) {
      const app = tenantAppOf(event.namespace, this.#own) ?? null;
      this.#remember(event.runId, app);
      return app;
    }
    return this.#apps.get(event.runId);
  }

  /** A tenant's event carries its app, and its partition as `namespace` (step events have none). */
  #with(event: EngineEvent, app: string | null): AttributedEngineEvent {
    if (app === null) return event;
    return event.namespace === undefined ? { ...event, namespace: app, app } : { ...event, app };
  }

  #remember(runId: string, app: string | null): void {
    if (this.#apps.has(runId)) this.#apps.delete(runId);
    else if (this.#apps.size >= this.#max) {
      const oldest = this.#apps.keys().next().value;
      if (oldest !== undefined) this.#apps.delete(oldest);
    }
    this.#apps.set(runId, app);
  }
}

/** The slice of the durable module options {@link controlPlaneAttribution} reads. */
export interface RunAppTopologyOptions {
  topology?: string | undefined;
  namespace?: string | undefined;
  partition?: string | undefined;
}

/**
 * The {@link RunAppAttribution} of a control plane, or `undefined` for any other topology (a
 * standalone app or a tenant pod attributes nothing). `getRun` reads a run's namespace (the engine's
 * or the store's); the control plane's own `namespace`/`partition` are its own runs.
 */
export function controlPlaneAttribution(
  options: RunAppTopologyOptions | undefined,
  getRun: (runId: string) => Promise<{ namespace?: string | undefined } | null>,
): RunAppAttribution | undefined {
  if (options?.topology !== 'control-plane') return undefined;
  const own = [options.namespace, options.partition].filter(
    (ns): ns is string => typeof ns === 'string' && ns !== '',
  );
  return {
    namespaceOf: async (runId) => (await getRun(runId))?.namespace,
    ...(own.length > 0 ? { own } : {}),
  };
}
