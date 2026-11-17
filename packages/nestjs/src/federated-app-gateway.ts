import {
  type ControlMessage,
  type ControlPlane,
  type DurableTopology,
  type EngineEvent,
  type FanPage,
  type FanPageQuery,
  type GroupHealth,
  type LifecycleKind,
  type RepublishLifecycleResult,
  type RepublishLifecycleTarget,
  type RunDetail,
  type RunDetailOptions,
  type RunFacetQuery,
  type RunFacetRow,
  type RunGateway,
  type RunListItem,
  type RunQuery,
  type RunReply,
  type RunRequestKind,
  type RunResult,
  type RunValueAxis,
  type RunValueFacetOptions,
  type RunValueFacetRow,
  type RunWaiting,
  type ScheduleAction,
  type ScheduleDescription,
  type ScheduleListQuery,
  type StateStore,
  type Transport,
  WorkflowEngine,
  type WorkflowLifecycleLinks,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { RunGatewayError } from './proxy-run-gateway';
import { StoreRunGateway } from './store-run-gateway';

/** Options for {@link federatedAppGateway}. */
export interface FederatedAppGatewayOptions {
  /**
   * A handle on the app's state store, used for READS only (runs, timelines, facets, schedules).
   * Typically a store adapter over the app's schema with a database user granted `SELECT` on it.
   * Nothing on this handle is written: actions go to the app (see {@link transport}).
   */
  store: StateStore;
  /**
   * A transport on the app's broker and prefix (e.g. `new BullMQTransport({ connection, prefix })`
   * with the app's own `prefix`), dedicated to this gateway. It carries the actions to the app as run
   * requests, which the app's own engine answers and executes, plus its live run events and worker
   * health. The gateway consumes no queue on it: the app's work is never taken by the console.
   */
  transport: Transport;
  /**
   * The token presented as the requester of each action, for an app whose engine verifies tenants
   * (`verifyTenant`, e.g. `hmacTenantVerifier(secret)`): `(namespace) => signTenantToken(namespace,
   * secret)`. Called with the namespace of the run or schedule acted on. Omitted: the namespace
   * itself is sent, which an app without `verifyTenant` trusts.
   */
  tenantToken?: (namespace: string) => string | Promise<string>;
  /**
   * Where the app's engines broadcast their lifecycle events (its `controlPlane`): what the console's
   * live tail of an app run listens on. Default: {@link transport} when it can broadcast (BullMQ
   * can), which is also the app's default. Only listened to, never published on.
   */
  controlPlane?: ControlPlane;
  /** How long an action waits for the app to answer. Default 10000 ms. */
  timeoutMs?: number;
}

interface Pending {
  resolve(data: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A `RunGateway` for ANOTHER app, for a federated console (the dashboard's `federation` option).
 * Reads come from the app's store; every action (cancel, retry, continue, signal, schedule
 * pause/resume/trigger, …) is published to the app over its broker as a run request, and the app's
 * own engine executes it, through the run-request responder every operator with a broker transport
 * already runs. The console process never drives, recovers or executes the app's runs.
 *
 * Each action names the namespace of the run (or schedule) it acts on as the requester, which the
 * app's responder checks the run against, exactly as it checks a tenant's request.
 */
export class FederatedAppGateway implements RunGateway {
  private readonly reads: StoreRunGateway;
  private readonly pending = new Map<string, Pending>();
  private listening = false;
  private readonly timeoutMs: number;
  /** Live-tail listeners by run id, fed by ONE subscription to the app's control channel. */
  private readonly tails = new Map<string, Set<(event: EngineEvent) => void>>();
  private tailing = false;

  constructor(private readonly options: FederatedAppGatewayOptions) {
    // An engine over the app's store with no transport and no driver: it only answers the reads
    // `StoreRunGateway` makes of it (children, lifecycle links). It starts no poller and consumes
    // nothing, so it never touches the app's runs.
    this.reads = new StoreRunGateway(options.store, new WorkflowEngine({ store: options.store }));
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  topology(): DurableTopology {
    return { role: 'control-plane' };
  }

  getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null> {
    return this.reads.getRunDetail(runId, options);
  }

  getFanMembers(runId: string, group: string, query: FanPageQuery): Promise<FanPage | null> {
    return this.reads.getFanMembers(runId, group, query);
  }

  getRun(runId: string): Promise<WorkflowRun | null> {
    return this.reads.getRun(runId);
  }

  listRuns(query: RunQuery): Promise<RunListItem[]> {
    return this.reads.listRuns(query);
  }

  runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    return this.reads.runFacets(query);
  }

  runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    return this.reads.runValueFacets(axis, query, opts);
  }

  waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>> {
    return this.reads.waitingFor(runIds);
  }

  workflowLifecycle(
    workflow: string,
    opts?: { namespace?: string | undefined },
  ): Promise<WorkflowLifecycleLinks> {
    return this.reads.workflowLifecycle(workflow, opts);
  }

  lifecycleSubscribers(
    workflow: string,
    kind: LifecycleKind,
    namespace: string,
  ): Promise<string[]> {
    return this.reads.lifecycleSubscribers(workflow, kind, namespace);
  }

  /** The app's worker groups, read from its broker (read-only). `[]` when the transport can't. */
  async workerHealth(): Promise<GroupHealth[]> {
    const { transport } = this.options;
    if (!transport.listWorkerGroups || !transport.groupHealth) return [];
    const groups = await transport.listWorkerGroups();
    return Promise.all(
      groups.map((group) => transport.groupHealth?.(group) as Promise<GroupHealth>),
    );
  }

  listSchedules(query: ScheduleListQuery): Promise<ScheduleDescription[]> {
    return this.reads.listSchedules(query);
  }

  getSchedule(id: string): Promise<ScheduleDescription | null> {
    return this.reads.getSchedule(id);
  }

  signalWaiter(token: string): Promise<string | null> {
    return this.reads.signalWaiter(token);
  }

  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.onRun(runId, (namespace) =>
      this.request(
        namespace,
        opts === undefined ? { kind: 'cancel', runId } : { kind: 'cancel', runId, opts },
      ),
    );
  }

  retry(runId: string): Promise<RunResult | null> {
    return this.onRun(runId, (namespace) => this.request(namespace, { kind: 'retry', runId }));
  }

  continue(runId: string): Promise<RunResult | null> {
    return this.onRun(runId, (namespace) => this.request(namespace, { kind: 'continue', runId }));
  }

  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return this.onRun(runId, (namespace) =>
      this.request(namespace, { kind: 'retryWithInput', runId, input }),
    );
  }

  redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null> {
    return this.onRun(runId, (namespace) => this.request(namespace, { kind: 'redispatch', runId }));
  }

  async republishLifecycle(target: RepublishLifecycleTarget): Promise<RepublishLifecycleResult> {
    let namespace: string | undefined;
    if ('runId' in target) {
      const run = await this.reads.getRun(target.runId);
      if (!run) throw new Error(`run ${target.runId} not found`);
      namespace = run.namespace || 'default';
    } else {
      namespace = target.namespace;
      if (namespace === undefined) {
        throw Object.assign(
          new Error('republish by workflow needs a namespace on a federated app'),
          {
            code: 'bad-request',
          },
        );
      }
    }
    return this.request(namespace, { kind: 'republishLifecycle', target });
  }

  /**
   * Pause, resume or trigger one of the app's persisted schedules, executed by the app. A schedule
   * that does not exist rejects with a `ScheduleNotFoundError`, as the engine's own client does.
   */
  async scheduleAction(
    id: string,
    action: ScheduleAction,
  ): Promise<ScheduleDescription | RunResult> {
    const schedule = await this.reads.getSchedule(id);
    if (!schedule) throw scheduleNotFound(id);
    try {
      return await this.request(schedule.namespace, { kind: 'schedule', id, action });
    } catch (err) {
      if (err instanceof RunGatewayError && err.code === 'not-found') throw scheduleNotFound(id);
      throw err;
    }
  }

  /**
   * Deliver `payload` to the app's run waiting on `token`, by the app. Null when no run of the app
   * waits on it yet: unlike the engine's own `signal`, nothing is buffered for a later wait.
   */
  async signal(token: string, payload: unknown): Promise<RunResult | null> {
    const runId = await this.reads.signalWaiter(token);
    if (!runId) return null;
    return this.onRun(runId, (namespace) =>
      this.request(namespace, { kind: 'signal', token, payload }),
    );
  }

  /**
   * The app's live events for `runId`, from the control channel its engines broadcast every event on
   * (see {@link FederatedAppGatewayOptions.controlPlane}). Nothing when there is none.
   */
  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    const control = this.controlPlane();
    if (!control) return () => undefined;
    if (!this.tailing) {
      this.tailing = true;
      control.onControl((msg) => this.deliver(msg));
    }
    let listeners = this.tails.get(runId);
    if (!listeners) {
      listeners = new Set();
      this.tails.set(runId, listeners);
    }
    listeners.add(onEvent);
    return () => {
      const current = this.tails.get(runId);
      current?.delete(onEvent);
      if (current?.size === 0) this.tails.delete(runId);
    };
  }

  private controlPlane(): ControlPlane | undefined {
    if (this.options.controlPlane) return this.options.controlPlane;
    const candidate = this.options.transport as Partial<ControlPlane>;
    return typeof candidate.onControl === 'function'
      ? (this.options.transport as unknown as ControlPlane)
      : undefined;
  }

  private deliver(msg: ControlMessage): void {
    if (this.tails.size === 0) return;
    const events = msg.kind === 'event' ? [msg.event] : msg.kind === 'events' ? msg.events : [];
    for (const event of events) {
      const listeners = this.tails.get(event.runId);
      if (!listeners) continue;
      // `at` crosses the wire as a string.
      const live = { ...event, at: new Date(event.at) };
      for (const listener of listeners) listener(live);
    }
  }

  /** `act` with the namespace of `runId`, or null when the app has no such run. */
  private async onRun<T>(
    runId: string,
    act: (namespace: string) => Promise<T | null>,
  ): Promise<T | null> {
    const run = await this.reads.getRun(runId);
    if (!run) return null;
    return act(run.namespace || 'default');
  }

  /** Send `body` to the app as a run request from `namespace`, and wait for its reply. */
  private async request<T>(namespace: string, body: RunRequestKind): Promise<T> {
    const { transport, tenantToken } = this.options;
    if (!transport.dispatchRunRequest || !transport.onRunReply) {
      throw new Error(
        'a federated app needs a transport that carries run requests (e.g. BullMQTransport)',
      );
    }
    this.listen();
    const tenant = tenantToken ? await tenantToken(namespace) : namespace;
    return new Promise<T>((resolve, reject) => {
      const requestId = globalThis.crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`the app did not answer ${body.kind} within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(requestId, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
      transport.dispatchRunRequest?.({ requestId, tenant, body })?.catch((error: unknown) => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.options.transport.onRunReply?.((reply) => this.handleReply(reply));
  }

  private handleReply(reply: RunReply): void {
    const entry = this.pending.get(reply.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(reply.requestId);
    if (reply.result.ok) entry.resolve(reply.result.data);
    else entry.reject(new RunGatewayError(reply.result.error.message, reply.result.error.code));
  }
}

function scheduleNotFound(id: string): Error {
  return Object.assign(new Error(`schedule "${id}" not found`), { name: 'ScheduleNotFoundError' });
}

/**
 * A `RunGateway` over another app's store (reads) and broker (actions, executed by that app), for
 * the dashboard's `federation.apps`. See {@link FederatedAppGateway}.
 */
export function federatedAppGateway(options: FederatedAppGatewayOptions): FederatedAppGateway {
  return new FederatedAppGateway(options);
}
