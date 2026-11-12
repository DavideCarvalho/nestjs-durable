import type {
  DeliveredEvent,
  DeliveryTransportContext,
  DurableTransportConfig,
  ListenerDelivery,
  ListenerDeliveryTransport,
} from '@dudousxd/nestjs-diagnostics/nestjs';
import {
  FatalError,
  type StepOptions,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import type { ModuleRef } from '@nestjs/core';

/** The internal workflow every diagnostics listener delivery runs as. */
export const DIAGNOSTICS_LISTENER_WORKFLOW = 'durable.diagnostics.listener';

/** Its version. */
export const DIAGNOSTICS_LISTENER_WORKFLOW_VERSION = '1';

/** The origin stamped on those runs, so the console groups them under diagnostics. */
export const DIAGNOSTICS_LISTENER_ORIGIN = '@dudousxd/nestjs-diagnostics';

/** The prefix of every delivery run id: `diag:<event id>:<listener id>`. */
export const DIAGNOSTICS_RUN_PREFIX = 'diag:';

/** The step that calls the listener. */
export const DIAGNOSTICS_LISTENER_STEP = 'handle';

/** The error code `ctx.invoke` rejects with when this process has no listener with that id. */
const UNKNOWN_LISTENER = 'E_UNKNOWN_DIAGNOSTICS_LISTENER';

const LIB = '@dudousxd/nestjs-durable-diagnostics';

/**
 * The retry policy a listener gets when `transports.durable()` sets none: three attempts, one
 * second apart and doubling, at most 30 seconds.
 */
export const DIAGNOSTICS_DEFAULT_RETRY: Readonly<StepOptions> = Object.freeze({
  retries: 3,
  backoff: 'exp',
  backoffMs: 1_000,
  backoffMaxMs: 30_000,
});

/** The input of a delivery run: which listener, and the event it receives. */
export interface DiagnosticsListenerInput {
  listenerId: string;
  envelope: DeliveredEvent;
}

/** The run id of one delivery. The same event and listener always give the same id. */
export function diagnosticsRunId(eventId: string, listenerId: string): string {
  return `${DIAGNOSTICS_RUN_PREFIX}${eventId}:${listenerId}`;
}

/** The tags a delivery run carries, so the console can filter by lib, event or listener. */
export function diagnosticsRunTags(delivery: ListenerDelivery): string[] {
  return [
    'diagnostics',
    `lib:${delivery.envelope.lib}`,
    `event:${delivery.envelope.event}`,
    `listener:${delivery.listenerId}`,
  ];
}

/**
 * Whether an engine event belongs to a delivery run. Those runs' own lifecycle events are not
 * forwarded to the diagnostics bus: a listener on `durable` events would otherwise start a delivery
 * run for every delivery run it caused, without end.
 */
export function isDiagnosticsDeliveryEvent(event: {
  runId?: string | undefined;
  workflow?: string | undefined;
}): boolean {
  if (event.workflow !== undefined) return event.workflow === DIAGNOSTICS_LISTENER_WORKFLOW;
  return typeof event.runId === 'string' && event.runId.startsWith(DIAGNOSTICS_RUN_PREFIX);
}

/** Validate `transports.durable(options)` and merge it over {@link DIAGNOSTICS_DEFAULT_RETRY}. */
export function diagnosticsStepOptions(config: DurableTransportConfig = {}): StepOptions {
  const options: StepOptions = { ...DIAGNOSTICS_DEFAULT_RETRY };
  if (config.retries !== undefined) {
    if (!Number.isInteger(config.retries) || config.retries < 1) {
      throw new Error(
        `${LIB}: transports.durable({ retries }) must be an integer of at least 1 (got ${String(config.retries)})`,
      );
    }
    options.retries = config.retries;
  }
  for (const key of ['backoffMs', 'backoffMaxMs'] as const) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `${LIB}: transports.durable({ ${key} }) must be a number of milliseconds of at least 0 (got ${String(value)})`,
      );
    }
    options[key] = value;
  }
  if (config.backoff !== undefined) {
    if (config.backoff !== 'fixed' && config.backoff !== 'exp') {
      throw new Error(
        `${LIB}: transports.durable({ backoff }) must be 'fixed' or 'exp' (got ${String(config.backoff)})`,
      );
    }
    options.backoff = config.backoff;
  }
  if (config.jitter !== undefined) options.jitter = config.jitter === true;
  return options;
}

/** The slice of the engine (or the thin start client) the transport starts runs with. */
interface RunStarter {
  start(
    workflow: string,
    input: unknown,
    runId: string,
    opts?: { tags?: string[] },
  ): Promise<unknown>;
}

/** The engine `WorkflowEngine` resolves to in this app, or `null` when durable isn't set up. */
function resolveEngine(moduleRef: ModuleRef): RunStarter | null {
  try {
    const engine = moduleRef.get<unknown>(WorkflowEngine, { strict: false });
    return typeof (engine as RunStarter | null)?.start === 'function'
      ? (engine as RunStarter)
      : null;
  } catch {
    return null;
  }
}

/**
 * The {@link ListenerDeliveryTransport} behind `transports.durable()`: each `(listener, event)` is a
 * run of {@link DIAGNOSTICS_LISTENER_WORKFLOW}, which calls the listener inside the `handle` step.
 */
export class DurableDeliveryTransport implements ListenerDeliveryTransport {
  readonly #engine: RunStarter;
  readonly #inFlight = new Set<Promise<void>>();
  #stopped = false;

  constructor(engine: RunStarter) {
    this.#engine = engine;
  }

  /**
   * Start one run per delivery and resolve once every run is stored. A delivery whose run already
   * exists (the same event handed over twice) counts as delivered. When some starts fail, the others
   * still go through and the returned promise rejects with the failures.
   */
  deliver(deliveries: readonly ListenerDelivery[]): Promise<void> {
    if (this.#stopped) {
      return Promise.reject(new Error(`${LIB}: the diagnostics delivery transport is stopped`));
    }
    const work = this.#startAll(deliveries);
    this.#inFlight.add(work);
    const forget = () => this.#inFlight.delete(work);
    work.then(forget, forget);
    return work;
  }

  async #startAll(deliveries: readonly ListenerDelivery[]): Promise<void> {
    const results = await Promise.allSettled(deliveries.map((d) => this.#start(d)));
    const errors = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `${LIB}: ${errors.length} of ${deliveries.length} diagnostics deliveries could not be started`,
      );
    }
  }

  async #start(delivery: ListenerDelivery): Promise<void> {
    const input: DiagnosticsListenerInput = {
      listenerId: delivery.listenerId,
      envelope: delivery.envelope,
    };
    // `start` is idempotent by run id: a second start of the same delivery returns the existing run.
    await this.#engine.start(
      DIAGNOSTICS_LISTENER_WORKFLOW,
      input,
      diagnosticsRunId(delivery.envelope.id, delivery.listenerId),
      { tags: diagnosticsRunTags(delivery) },
    );
  }

  /** Stop taking deliveries and wait for the runs being created. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.allSettled([...this.#inFlight]);
  }
}

/**
 * Register {@link DIAGNOSTICS_LISTENER_WORKFLOW} on `engine`. Its run calls the listener through
 * `invoke` in a `handle` step with the given retry policy. A listener this process does not know is
 * a {@link FatalError}: retrying cannot make it appear.
 */
export function registerDiagnosticsListenerWorkflow(
  engine: WorkflowEngine,
  invoke: DeliveryTransportContext['invoke'],
  stepOptions: StepOptions,
): void {
  engine.register(
    DIAGNOSTICS_LISTENER_WORKFLOW,
    DIAGNOSTICS_LISTENER_WORKFLOW_VERSION,
    async (ctx: WorkflowCtx, raw: unknown) => {
      const { listenerId, envelope } = raw as DiagnosticsListenerInput;
      await ctx.localStep(
        DIAGNOSTICS_LISTENER_STEP,
        async () => {
          try {
            await invoke(listenerId, envelope);
          } catch (error) {
            if ((error as { code?: unknown } | null)?.code === UNKNOWN_LISTENER) {
              throw new FatalError(
                error instanceof Error
                  ? error.message
                  : `unknown diagnostics listener ${listenerId}`,
                UNKNOWN_LISTENER,
                { listenerId },
              );
            }
            throw error;
          }
          return null;
        },
        stepOptions,
      );
    },
    { tags: ['diagnostics'], origin: DIAGNOSTICS_LISTENER_ORIGIN },
  );
}

/** Whether a durable engine resolves from `moduleRef` (`DurableModule` is imported). */
export function isConfigured(moduleRef: ModuleRef): boolean {
  return resolveEngine(moduleRef) !== null;
}

/**
 * Create the delivery transport for this process. Unless `role` is `'api'`, the listener workflow
 * is registered on the app's engine, so this process runs deliveries. On `'api'` the workflow is
 * start-only: this process stores the runs and a worker runs them.
 */
export function createDeliveryTransport(
  context: DeliveryTransportContext,
  config: DurableTransportConfig = {},
): DurableDeliveryTransport {
  const stepOptions = diagnosticsStepOptions(config);
  const engine = resolveEngine(context.moduleRef);
  if (!engine) {
    throw new Error(`${LIB}: no durable engine resolves in this app. Import DurableModule.`);
  }
  if (engine instanceof WorkflowEngine) {
    if (context.role === 'api') {
      engine.registerStartOnly(
        DIAGNOSTICS_LISTENER_WORKFLOW,
        DIAGNOSTICS_LISTENER_WORKFLOW_VERSION,
        {
          tags: ['diagnostics'],
          origin: DIAGNOSTICS_LISTENER_ORIGIN,
        },
      );
    } else {
      registerDiagnosticsListenerWorkflow(engine, context.invoke, stepOptions);
    }
  } else if (context.role !== 'api') {
    // A thin worker (`DurableModule` with `connection` only) starts runs on an operator and runs no
    // workflow body here, so it can't run deliveries.
    throw new Error(
      `${LIB}: this process runs durable as a thin client (no \`store\`), which can't run diagnostics deliveries. Set \`role: 'api'\` on its DiagnosticsModule so it only starts them, and run deliveries on a process with a durable store.`,
    );
  }
  return new DurableDeliveryTransport(engine);
}
