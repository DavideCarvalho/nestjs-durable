import type { Heartbeat, NamedTransport, RemoteTask, StepResult } from './interfaces';

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

  /** Register the engine's result/heartbeat handlers on EVERY transport — a result can come back on
   *  whichever one delivered the task, so failover stays symmetric. */
  bind(
    onResult: (result: StepResult) => Promise<void>,
    onHeartbeat: (beat: Heartbeat) => Promise<void>,
  ): void {
    for (const { transport } of this.transports) {
      transport.onResult(onResult);
      transport.onHeartbeat(onHeartbeat);
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

  /** Pinned `preferId` first, then the rest (failover order). */
  private ordered(preferId?: string): NamedTransport[] {
    if (!preferId) return this.transports;
    const pref = this.transports.filter((t) => t.id === preferId);
    if (pref.length === 0) throw new Error(`transport "${preferId}" is not registered`);
    return [...pref, ...this.transports.filter((t) => t.id !== preferId)];
  }
}
