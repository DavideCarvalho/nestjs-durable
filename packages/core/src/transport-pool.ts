import type {
  GroupHealth,
  Heartbeat,
  NamedTransport,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowStepEvent,
} from './interfaces';

/**
 * An ordered pool of named transports. The engine dispatches on the first and fails over to the
 * next on a dispatch error; a step can pin one by id. Pure transport plumbing — no run lifecycle —
 * so it lives apart from the engine.
 */
export class TransportPool {
  constructor(private readonly transports: NamedTransport[]) {}

  get size(): number {
    return this.transports.length;
  }

  /**
   * The primary (first) transport — the one `dispatch` prefers when no `preferId` is pinned. A
   * {@link RemoteWorkflowExecutor} built by `engine.remote()` rides it (it needs a single
   * `dispatchWorkflowTask`/`onDecision` Transport, not the whole failover pool). Throws if the pool
   * is empty — there is nothing to dispatch a remote workflow over.
   */
  get primary(): Transport {
    const first = this.transports[0];
    if (!first) {
      throw new Error(
        'no transport configured — engine.remote() needs a transport (or transports)',
      );
    }
    return first.transport;
  }

  /** Register the engine's result/heartbeat/step-event handlers on EVERY transport — a result can come
   *  back on whichever one delivered the task, so failover stays symmetric. `onStepEvent` is wired only
   *  on transports that carry streamed workflow step lifecycle (BullMQ); others simply skip it. */
  bind(
    onResult: (result: StepResult) => Promise<void>,
    onHeartbeat: (beat: Heartbeat) => Promise<void>,
    onStepEvent?: (event: WorkflowStepEvent) => Promise<void>,
    onDecision?: (decision: WorkflowDecision) => Promise<void>,
  ): void {
    for (const { transport } of this.transports) {
      transport.onResult(onResult);
      transport.onHeartbeat(onHeartbeat);
      if (onStepEvent && transport.onStepEvent) {
        transport.onStepEvent(onStepEvent);
      }
      // A workflow-turn decision can come back on whichever transport carried the task — and on
      // whichever ENGINE INSTANCE consumes it (point-to-point), which may NOT be the dispatcher. The
      // engine applies it durably by run id, so binding it here (like onResult) is multi-instance safe.
      if (onDecision && transport.onDecision) {
        transport.onDecision(onDecision);
      }
    }
  }

  /**
   * Dispatch `task` over the pool: try the preferred (or first) transport, fail over to the next on
   * a dispatch error, and stamp the task with the id of the transport that accepted it (so a worker
   * replies on the matching one). Throws if every transport fails.
   */
  async dispatch(task: Omit<RemoteTask, 'transport'>, preferId?: string): Promise<void> {
    let lastErr: unknown;
    for (const { id, transport } of this.ordered(preferId)) {
      try {
        await transport.dispatch({ ...task, transport: id });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('no transport accepted the dispatch');
  }

  /** Worker-health for `group`, merged across every transport that can report it (a group's queue
   *  and its workers may live on any pinned transport). Undefined when no transport implements
   *  `groupHealth` (e.g. a pure in-process transport — nothing to introspect). */
  async groupHealth(group: string): Promise<GroupHealth | undefined> {
    const reports: GroupHealth[] = [];
    for (const { transport } of this.transports) {
      if (transport.groupHealth) reports.push(await transport.groupHealth(group));
    }
    if (reports.length === 0) return undefined;
    return {
      group,
      depth: reports.reduce((sum, r) => sum + r.depth, 0),
      liveWorkers: reports.flatMap((r) => r.liveWorkers),
    };
  }

  /** Distinct worker groups with a live heartbeat, merged across every transport that can report it. */
  async listWorkerGroups(): Promise<string[]> {
    const groups = new Set<string>();
    for (const { transport } of this.transports) {
      if (transport.listWorkerGroups) {
        for (const g of await transport.listWorkerGroups()) groups.add(g);
      }
    }
    return [...groups];
  }

  /**
   * Propagate the engine's `namespace` to every transport that partitions by it — so the same
   * namespace that scopes the store also scopes each transport's queues/keys. A transport that
   * doesn't partition (no `useNamespace`) is skipped. Idempotent; a transport given an explicit
   * namespace at construction ignores this (see {@link Transport.useNamespace}).
   */
  useNamespace(namespace: string): void {
    for (const { transport } of this.transports) {
      transport.useNamespace?.(namespace);
    }
  }

  /** Pinned `preferId` first, then the rest (failover order). */
  private ordered(preferId?: string): NamedTransport[] {
    if (!preferId) return this.transports;
    const pref = this.transports.filter((t) => t.id === preferId);
    if (pref.length === 0) throw new Error(`transport "${preferId}" is not registered`);
    return [...pref, ...this.transports.filter((t) => t.id !== preferId)];
  }
}
