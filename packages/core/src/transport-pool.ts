import type { WorkerDescriptor } from './handshake/descriptor';
import type {
  GroupHealth,
  Heartbeat,
  NamedTransport,
  RemoteTask,
  RunConsumerOptions,
  RunDispatch,
  RunQueueOptions,
  StartRunMessage,
  StepResult,
  Transport,
  WorkerHeartbeat,
  WorkflowDecision,
  WorkflowStepEvent,
} from './interfaces';

/** Most tasks {@link TransportPool.dispatchMany} dispatches at once when it sends them one by one. */
const DISPATCH_CHUNK = 200;

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

  /**
   * {@link dispatch} for many tasks: one {@link Transport.dispatchMany} call on the preferred (or
   * first) transport when it has one, else (or when that call rejects) each task through
   * {@link dispatch}, a bounded number at a time.
   */
  async dispatchMany(tasks: Omit<RemoteTask, 'transport'>[], preferId?: string): Promise<void> {
    if (tasks.length === 0) return;
    const first = this.ordered(preferId)[0];
    if (first?.transport.dispatchMany) {
      try {
        await first.transport.dispatchMany(tasks.map((task) => ({ ...task, transport: first.id })));
        return;
      } catch {
        // Fall through: dispatch them one by one, failing over per task.
      }
    }
    for (let at = 0; at < tasks.length; at += DISPATCH_CHUNK) {
      await Promise.all(
        tasks.slice(at, at + DISPATCH_CHUNK).map((task) => this.dispatch(task, preferId)),
      );
    }
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

  /**
   * Register a control-plane `start-run` consumer on every transport that carries the channel. Only
   * control-plane-side transports implement {@link Transport.onStartRun}; a transport without it is
   * skipped, so a plain worker/in-process pool is a no-op. Mirrors {@link bind}'s per-transport wiring.
   */
  onStartRun(handler: (msg: StartRunMessage) => Promise<void>): void {
    for (const { transport } of this.transports) {
      transport.onStartRun?.(handler);
    }
  }

  /** Does any transport here carry a run queue ({@link Transport.dispatchRuns} + `onDispatchedRun`)? */
  get dispatchesRuns(): boolean {
    return this.transports.some(
      ({ transport }) => transport.dispatchRuns && transport.onDispatchedRun,
    );
  }

  /**
   * Queue `runs` on the first transport that carries a run queue, failing over to the next on an
   * error, like {@link dispatch}. Throws if none accepted them.
   */
  async dispatchRuns(runs: readonly RunDispatch[], opts?: RunQueueOptions): Promise<void> {
    let lastErr: unknown;
    for (const { transport } of this.transports) {
      if (!transport.dispatchRuns || !transport.onDispatchedRun) continue;
      try {
        await transport.dispatchRuns(runs, opts);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('no transport carries a run queue');
  }

  /**
   * Consume the run queue of every transport that carries one (a run may have been queued on any of
   * them after a failover). Returns one stop function per consumer.
   */
  onDispatchedRun(
    handler: (run: RunDispatch) => Promise<void>,
    opts: RunConsumerOptions,
  ): (() => Promise<void>)[] {
    const stops: (() => Promise<void>)[] = [];
    for (const { transport } of this.transports) {
      if (!transport.dispatchRuns || !transport.onDispatchedRun) continue;
      stops.push(transport.onDispatchedRun(handler, opts));
    }
    return stops;
  }

  /**
   * The live handshake descriptors advertised for `group` (design §7.2), merged across every transport
   * that can report them. Returns `[]` when NO transport implements
   * {@link Transport.readWorkerDescriptors} (a pure in-process pool) OR when descriptors are supported
   * but none is published — both are the "guard disengaged / legacy assume-compatible" case, so the
   * engine's routing guard treats an empty result identically (design §7.7).
   */
  async readWorkerDescriptors(group: string): Promise<WorkerDescriptor[]> {
    const descriptors: WorkerDescriptor[] = [];
    for (const { transport } of this.transports) {
      if (transport.readWorkerDescriptors) {
        descriptors.push(...(await transport.readWorkerDescriptors(group)));
      }
    }
    return descriptors;
  }

  /**
   * Every live descriptor in the deployment, merged across every transport that can report them and
   * de-duplicated by `instanceId` — one worker publishes the same descriptor under each token it
   * consumes, and it must count once. Returns `[]` when no transport implements
   * {@link Transport.readAllWorkerDescriptors} (a pure in-process pool advertises nothing).
   *
   * First writer wins on a duplicate id: the copies are the same bytes by construction (one process,
   * one descriptor, published N times), so there is nothing to choose between. Two DIFFERENT
   * processes sharing an `instanceId` would collapse into one here — that is a misconfiguration the
   * fleet already suffers from (they also share heartbeat and descriptor keys, so they overwrite each
   * other's advertisement), not something this read can repair.
   */
  async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
    const byInstance = new Map<string, WorkerDescriptor>();
    for (const { transport } of this.transports) {
      if (!transport.readAllWorkerDescriptors) continue;
      for (const descriptor of await transport.readAllWorkerDescriptors()) {
        if (!byInstance.has(descriptor.instanceId))
          byInstance.set(descriptor.instanceId, descriptor);
      }
    }
    return [...byInstance.values()];
  }

  /**
   * Every live worker heartbeat in the deployment, merged across every transport that can report
   * them and de-duplicated by `(group, instanceId)` — the same worker is one beat per token, and two
   * transports scanning the same keyspace must not double-count it.
   *
   * Returns `[]` when no transport implements {@link Transport.readAllWorkerHeartbeats}, which is
   * indistinguishable from "nothing is beating" on its own — {@link introspectsFleet} is what tells
   * those apart, and the directory reads it rather than guessing from an empty array.
   */
  async readAllWorkerHeartbeats(): Promise<WorkerHeartbeat[]> {
    const seen = new Map<string, WorkerHeartbeat>();
    for (const { transport } of this.transports) {
      if (!transport.readAllWorkerHeartbeats) continue;
      for (const beat of await transport.readAllWorkerHeartbeats()) {
        const key = `${beat.group} ${beat.instanceId}`;
        if (!seen.has(key)) seen.set(key, beat);
      }
    }
    return [...seen.values()];
  }

  /**
   * Can ANY transport here introspect the fleet — descriptors or heartbeats? This is the difference
   * between "the fleet is empty" and "nobody asked", and it is a property of the POOL rather than of
   * a read's result, so it stays answerable when both reads legitimately come back empty.
   */
  get introspectsFleet(): boolean {
    return this.transports.some(
      ({ transport }) => transport.readAllWorkerDescriptors || transport.readAllWorkerHeartbeats,
    );
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
   * The first transport (in pool order) reporting a LIVE heartbeat for `group` — the one a
   * convention-routed remote workflow must dispatch on. In a mixed pool (e.g. a tenant-scoped
   * control plane pairing its namespaced transport with a bare-prefix one for operator-convention
   * tenant workers), each transport sees a DIFFERENT keyspace: dispatching on `primary` while the
   * live worker heartbeats on another transport parks the task on a queue nobody consumes. Returns
   * `undefined` when no transport reports the group (mirrors the merged `listWorkerGroups` miss).
   */
  async transportWithLiveGroup(group: string): Promise<Transport | undefined> {
    for (const { transport } of this.transports) {
      if (!transport.listWorkerGroups) continue;
      if ((await transport.listWorkerGroups()).includes(group)) return transport;
    }
    return undefined;
  }

  /** Pinned `preferId` first, then the rest (failover order). */
  private ordered(preferId?: string): NamedTransport[] {
    if (!preferId) return this.transports;
    const pref = this.transports.filter((t) => t.id === preferId);
    if (pref.length === 0) throw new Error(`transport "${preferId}" is not registered`);
    return [...pref, ...this.transports.filter((t) => t.id !== preferId)];
  }
}
