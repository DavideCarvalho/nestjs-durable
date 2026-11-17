import type { StartRunDeps } from '@dudousxd/durable-worker';
import {
  type ConcurrencyConfig,
  type OnEventEntry,
  type RunResult,
  type RunTenant,
  type SignalOptions,
  type SingletonConfig,
  type StartOptions,
  type StartRunMessage,
  type StartRunSingleton,
  type TenantTokenSource,
  type WorkflowClass,
  type WorkflowInputOf,
  acceptingSubscription,
  resolveConcurrency,
  resolveTenantToken,
  toEventSubscription,
  workflowName,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import type { ContextAccessor } from './context-accessor';
import type { DurableModuleOptions } from './durable.module';
import { currentTenant } from './tenancy';
import { resolveTenantTokenSource } from './tenant-contracts';
import { startRun } from './worker-sdk';

/**
 * The `@Workflow` options a tenant's start applies itself, before it publishes the start-run: the
 * ones that are functions of the input, which the control plane (knowing the workflow by name
 * alone) cannot evaluate. Declared by `ThinWorkflowRegistrar` for every `@Workflow` it discovers.
 */
export interface TenantWorkflowStartPolicy {
  /** `@Workflow({ input, validateInput })`: rejects the start (throws) before anything is published. */
  validateInput?: ((input: unknown) => void | Promise<void>) | undefined;
  /** `@Workflow({ singleton })`: its key is evaluated here and carried on the start-run. */
  singleton?: SingletonConfig | undefined;
  /** `@Workflow({ concurrency })`: the default quota, evaluated here unless the start passes one. */
  concurrency?: ConcurrencyConfig | undefined;
  /** `@Workflow({ onEvent })` / `@OnDurableEvent`: started by this app's own `publishEvent`. */
  onEvent?: OnEventEntry[] | undefined;
  /** The workflow coalesces its event triggers (`debounce`/`batch`), which a tenant cannot apply. */
  coalesces?: boolean | undefined;
}

/**
 * Where a tenant's `signal`/`signalWithStart`/`publishEvent` go: run requests to the control plane
 * (the module's `ProxyRunGateway` over `transport`).
 */
export interface TenantRunRequests {
  signal(token: string, payload: unknown, opts?: SignalOptions): Promise<RunResult | null>;
  signalWithStart(
    start: Omit<StartRunMessage, 'tenant'> & { runId: string },
    signal: { token: string; payload?: unknown },
  ): Promise<{ runId: string; signalled: boolean }>;
  publishEvent(name: string, payload: unknown, opts?: { id?: string }): Promise<number>;
}

/**
 * The **store-less `engine.start` facade** for a tenant worker. Provided under the `WorkflowEngine`
 * DI token by {@link import('./durable.module').DurableModule} (`forRoot({ connection })`, no
 * `store`), so tenant code calls `engine.start(...)` UNCHANGED — it has no idea it is a tenant.
 * Instead of touching a DB, `start` publishes a `StartRunMessage` on the SHARED `durable-start-run`
 * queue (Option B: tenant rides as message DATA, never as wire segmentation). The operator (control
 * plane, `namespace: undefined`) consumes it, stamps the run's namespace from `tenant`, and routes
 * the run's task to `<workflow>@<tenant>` — the partition THIS tenant's worker serves.
 *
 * `cancel`/`deleteRun` need the store/driver a tenant does not have; they throw. No wire message
 * exists for them (the operator owns cancellation/retention).
 */
@Injectable()
export class DurableStartClient {
  private readonly tenant: string;
  private readonly tenantToken: TenantTokenSource | undefined;
  private readonly policies = new Map<string, TenantWorkflowStartPolicy>();
  private readonly warnedCoalescing = new Set<string>();

  constructor(
    private readonly options: DurableModuleOptions,
    private readonly deps?: StartRunDeps,
    /** The context accessor, for the customer tenant a start claims (else the global slot). */
    private readonly accessor?: ContextAccessor,
    /**
     * Sends `signal`/`signalWithStart`/`publishEvent` to the control plane as run requests (the
     * module's `ProxyRunGateway` over `transport`). Absent (no `transport`): they reject, naming it.
     */
    private readonly requests?: () => TenantRunRequests | undefined,
  ) {
    this.tenant = options.partition ?? 'default';
    this.tenantToken = resolveTenantTokenSource(options.tenantToken);
  }

  /**
   * Apply `policy` to every start of `workflow` from this process (see
   * {@link TenantWorkflowStartPolicy}). Called by `ThinWorkflowRegistrar` at boot.
   */
  declareWorkflow(workflow: string, policy: TenantWorkflowStartPolicy): void {
    this.policies.set(workflow, policy);
  }

  /**
   * The start-run fields a declared policy adds for `input`: it validates the input (throwing), and
   * evaluates the singleton key and the default quota. A per-start `concurrency` wins over the
   * workflow's.
   */
  private async applyPolicy(
    workflow: string,
    input: unknown,
    opts: StartOptions | undefined,
  ): Promise<{ singleton?: StartRunSingleton; concurrency?: StartOptions['concurrency'] }> {
    const policy = this.policies.get(workflow);
    if (!policy) return opts?.concurrency !== undefined ? { concurrency: opts.concurrency } : {};
    await policy.validateInput?.(input);
    const concurrency = await resolveConcurrency(opts?.concurrency, policy.concurrency, input);
    const singleton = policy.singleton
      ? {
          key: policy.singleton.key(input),
          ...(policy.singleton.limit !== undefined ? { limit: policy.singleton.limit } : {}),
          ...(policy.singleton.maxQueueDepth !== undefined
            ? { maxQueueDepth: policy.singleton.maxQueueDepth }
            : {}),
        }
      : undefined;
    return {
      ...(singleton ? { singleton } : {}),
      ...(concurrency ? { concurrency } : {}),
    };
  }

  /** The wire `tenant`: the signed token when configured, else the partition. */
  private async wireTenant(): Promise<string> {
    return this.tenantToken !== undefined
      ? await resolveTenantToken(this.tenantToken)
      : this.tenant;
  }

  /**
   * The customer tenant a start claims: an explicit `tenantId` (`null` = none), else the request's
   * tenant when tenancy is on.
   */
  private claimedTenant(opts: StartOptions | undefined): RunTenant | undefined {
    return opts?.tenantId !== undefined
      ? opts.tenantId === null
        ? undefined
        : { id: opts.tenantId, ...(opts.tenantKind !== undefined ? { kind: opts.tenantKind } : {}) }
      : currentTenant(this.options.tenancy, this.accessor);
  }

  start<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId?: string,
    opts?: StartOptions,
  ): Promise<RunResult>;
  start(workflow: string, input: unknown, runId?: string, opts?: StartOptions): Promise<RunResult>;
  async start(
    workflow: string,
    input: unknown,
    runId: string = globalThis.crypto.randomUUID(),
    opts?: StartOptions,
  ): Promise<RunResult> {
    const message = await this.startMessage(workflowName(workflow), input, runId, opts);
    await startRun(this.options.connection, {
      // The signed token (when configured) rides in the `tenant` field, as on every run request; an
      // operator with `verifyTenant` derives the run's namespace from it.
      tenant: await this.wireTenant(),
      ...message,
      // Option B: DO NOT pass `namespace` — the start-run queue stays the shared
      // `durable-start-run` the operator consumes; tenant rides only as message data.
      ...(this.options.prefix !== undefined ? { prefix: this.options.prefix } : {}),
      ...(this.deps !== undefined ? { deps: this.deps } : {}),
    });
    // As `engine.start` reports it: a start delayed into the future reads `suspended` until it fires.
    const startAtMs = message.startAt;
    return {
      runId,
      status:
        startAtMs !== undefined && Number.isFinite(startAtMs) && startAtMs > Date.now()
          ? 'suspended'
          : 'pending',
    };
  }

  /**
   * The start-run a start of `name` sends (everything but the wire `tenant`): the start options the
   * control plane applies (version pin, priority, delayed start, quota), the singleton key and the
   * customer tenant this run claims. Applies the workflow's declared policy first, so a rejected
   * input throws before anything is published, as `engine.start` does.
   */
  private async startMessage(
    name: string,
    input: unknown,
    runId: string,
    opts: StartOptions | undefined,
  ): Promise<Omit<StartRunMessage, 'tenant'> & { runId: string }> {
    // The control plane keeps the claimed customer tenant only with a `tenancy:` capability on
    // this process's token.
    const tenant = this.claimedTenant(opts);
    const policy = await this.applyPolicy(name, input, opts);
    const startAt = opts?.startAt instanceof Date ? opts.startAt.getTime() : opts?.startAt;
    return {
      workflow: name,
      input,
      runId,
      ...(opts?.tags !== undefined ? { tags: opts.tags } : {}),
      ...(opts?.searchAttributes !== undefined ? { searchAttributes: opts.searchAttributes } : {}),
      ...(opts?.version !== undefined ? { version: opts.version } : {}),
      ...(opts?.priority !== undefined ? { priority: opts.priority } : {}),
      ...(startAt !== undefined ? { startAt } : {}),
      ...(policy.concurrency !== undefined ? { concurrency: policy.concurrency } : {}),
      ...(policy.singleton !== undefined ? { singleton: policy.singleton } : {}),
      ...(tenant
        ? { tenantId: tenant.id, ...(tenant.kind !== undefined ? { tenantKind: tenant.kind } : {}) }
        : {}),
    };
  }

  /** The control plane's run requests, or a clear error naming what is missing. */
  private runRequests(method: string): TenantRunRequests {
    const requests = this.requests?.();
    if (!requests) {
      throw new Error(
        `${method}() on a tenant is sent to the control plane as a run request, which needs \`transport\` on DurableModule.forRoot (the tenant's BullMQTransport).`,
      );
    }
    return requests;
  }

  /**
   * Signal the run of this tenant's partition waiting on `token`, through the control plane.
   * Resolves the resumed run, or null when no run of this partition waits on it: unlike
   * `engine.signal` on a control plane, a tenant's signal is NOT buffered for a wait opened later
   * (another partition's run could open it). Use `signalWithStart` to signal a run that may not wait
   * yet. `opts.id` deduplicates like `engine.signal`.
   */
  async signal(token: string, payload: unknown, opts?: SignalOptions): Promise<RunResult | null> {
    return this.runRequests('signal').signal(token, payload, opts);
  }

  /**
   * Ensure the run `runId` of `workflow` exists in this tenant's partition (started like
   * {@link start}, with the same options and policy), then signal it. The control plane buffers the
   * signal until the run waits on `signal.token` only when the token contains `runId` (a run-scoped
   * token, the pattern `signalWithStart` is for): a token that does not is delivered only to a run
   * of this partition already waiting on it, and refused otherwise.
   */
  signalWithStart<C extends WorkflowClass>(
    workflow: C,
    input: WorkflowInputOf<C>,
    runId: string,
    signal: { token: string; payload?: unknown },
    opts?: StartOptions,
  ): Promise<{ runId: string }>;
  signalWithStart(
    workflow: string,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
    opts?: StartOptions,
  ): Promise<{ runId: string }>;
  async signalWithStart(
    workflow: string,
    input: unknown,
    runId: string,
    signal: { token: string; payload?: unknown },
    opts?: StartOptions,
  ): Promise<{ runId: string }> {
    const requests = this.runRequests('signalWithStart');
    const start = await this.startMessage(workflowName(workflow), input, runId, opts);
    const result = await requests.signalWithStart(start, signal);
    return { runId: result.runId };
  }

  /**
   * Publish event `name` from this tenant. Starts this app's own `onEvent` subscribers (each one
   * whose `where` accepts the payload, with its `input` mapping) as runs of this partition, by the
   * start path ({@link start}, run id `evt:<id>:<workflow>`), and has the control plane resume the
   * runs of this partition waiting on it (`ctx.waitForEvent`). Resolves how many runs it started or
   * resumed; a subscriber that throws is warned about and skipped. Unlike a control plane's
   * `publishEvent`, an event nobody received is not buffered (there is no `buffer` option), and
   * a subscriber's `debounce`/`batch` is not applied (it starts once per event, with a warning).
   */
  async publishEvent(name: string, payload: unknown, opts?: { id?: string }): Promise<number> {
    const requests = this.runRequests('publishEvent');
    const eventId = opts?.id ?? globalThis.crypto.randomUUID();
    let started = 0;
    for (const [workflow, policy] of this.policies) {
      // One subscriber that throws (its `where`, its `input`, or its start) must not keep the
      // others, or the control plane's resume of the waiting runs, from getting the event: as on a
      // control plane, it is reported and skipped.
      try {
        const subscriptions = (policy.onEvent ?? [])
          .map(toEventSubscription)
          .filter((sub) => sub.event === name);
        const { accepted, errors } = acceptingSubscription(subscriptions, payload);
        if (!accepted) {
          if (errors.length > 0) throw errors[0];
          continue;
        }
        if (policy.coalesces && !this.warnedCoalescing.has(workflow)) {
          this.warnedCoalescing.add(workflow);
          console.warn(
            `[nestjs-durable] ${workflow} debounces/batches its events, which a tenant's publishEvent does not apply: it starts once per event.`,
          );
        }
        const input = accepted.input ? accepted.input(payload) : payload;
        await this.start(workflow, input, `evt:${eventId}:${workflow}`);
        started += 1;
      } catch (error) {
        console.warn(`[nestjs-durable] event ${name}: subscriber ${workflow} not started:`, error);
      }
    }
    const resumed = await requests.publishEvent(name, payload, { id: eventId });
    return started + resumed;
  }

  cancel(_runId: string): Promise<void> {
    return tenantUnsupported('cancel');
  }

  deleteRun(_runId: string): Promise<void> {
    return tenantUnsupported('deleteRun');
  }

  // — everything below rejects: a tenant worker holds no store/driver. —

  // `resume`/`waitForRun` need the store or driver a tenant does not have. They exist so a mistaken
  // call fails with a CLEAR, named tenant error instead of a cryptic `this.engine.X is not a
  // function`. Params mirror the WorkflowEngine surface; every method rejects without reading them.
  resume(_runId: string): Promise<void> {
    return tenantUnsupported('resume');
  }

  waitForRun(
    _runId: string,
    _opts?: { timeoutMs?: number; until?: 'settled' | 'terminal' },
  ): Promise<void> {
    return tenantUnsupported('waitForRun');
  }
}

/** Reject with a clear, named tenant error for an operation that needs a store/driver. */
function tenantUnsupported(method: string): Promise<void> {
  return Promise.reject(
    new Error(
      `${method}() is not available on a tenant worker (no store). Use the control plane for it.`,
    ),
  );
}
