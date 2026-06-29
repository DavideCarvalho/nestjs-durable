import type {
  ControlMessage,
  ControlPlane,
  Heartbeat,
  RemoteTask,
  StepResult,
  Transport,
  WorkflowDecision,
  WorkflowStepEvent,
  WorkflowTask,
} from '../interfaces';
import { type StepHandler, runStepHandler } from '../protocol';

/** Replays one workflow turn (a {@link WorkflowTask}) into its {@link WorkflowDecision} — the stand-in
 *  for the Python `@workflow` worker that produces the turn's commands. Registered via `serveWorkflow`. */
export type WorkflowWorker = (task: WorkflowTask) => Promise<WorkflowDecision> | WorkflowDecision;

/**
 * A point-to-point `Transport` for the MULTI-INSTANCE regression test: it models a broker shared by
 * SEVERAL engine instances ("pods"), each of which registers its own `onResult` / `onDecision` /
 * `onHeartbeat` handler. The defining property — and the whole reason the multi-instance bug exists —
 * is that a dispatched WORKFLOW-TURN DECISION (and, to be faithful, each step RESULT) is delivered to
 * EXACTLY ONE registered consumer, NOT broadcast. Real `<prefix>-decisions` / `<prefix>-results`
 * queues are point-to-point: whichever instance grabs the message gets it — often NOT the instance
 * that dispatched the turn and is awaiting its reply.
 *
 * Decisions are delivered to a NON-dispatching consumer when more than one is registered (index ≥ 1;
 * the dispatcher subscribes first, at index 0). With the legacy in-memory mechanism the dispatcher
 * alone held the waiter, so a decision handed to a different instance was DROPPED → the run stuck
 * `suspended`. The durable fix applies the decision by run id on whatever instance consumes it, so the
 * non-dispatcher completes it.
 *
 * Pass the SAME instance as both `transport` and `controlPlane` to every engine sharing the broker.
 */
export class PointToPointDecisionTransport implements Transport, ControlPlane {
  private readonly handlers = new Map<string, StepHandler>();
  private readonly resultConsumers: Array<(result: StepResult) => Promise<void>> = [];
  private readonly decisionConsumers: Array<(decision: WorkflowDecision) => Promise<void>> = [];
  private readonly heartbeatConsumers: Array<(beat: Heartbeat) => Promise<void>> = [];
  private readonly controlHandlers = new Set<(msg: ControlMessage) => void>();
  private worker?: WorkflowWorker;
  private resultCursor = 0;

  /** Register a fake worker handler for a remote step name (the `call` commands' targets). */
  handle(name: string, fn: StepHandler): void {
    this.handlers.set(name, fn);
  }

  /** Register the workflow-turn replay (the Python `@workflow` stand-in) that turns a dispatched
   *  {@link WorkflowTask} into its {@link WorkflowDecision}. */
  serveWorkflow(fn: WorkflowWorker): void {
    this.worker = fn;
  }

  async dispatch(task: RemoteTask): Promise<void> {
    if (this.resultConsumers.length === 0) throw new Error('no result handler registered');
    const result = await runStepHandler(task, this.handlers.get(task.name));
    // Point-to-point: round-robin the result to EXACTLY ONE instance (a real results queue is
    // point-to-point). `completeRemoteResult` is durable (looks the run up by id), so whichever
    // instance receives it can resume the run. Async, like a real broker — mirrors InMemoryTransport.
    const consumer = this.resultConsumers[this.resultCursor % this.resultConsumers.length];
    this.resultCursor += 1;
    setImmediate(() => void consumer?.(result));
  }

  onResult(handler: (result: StepResult) => Promise<void>): void {
    this.resultConsumers.push(handler);
  }

  onHeartbeat(handler: (beat: Heartbeat) => Promise<void>): void {
    this.heartbeatConsumers.push(handler);
  }

  /** Test hook: deliver a liveness heartbeat to one instance, as a real broker would on its channel. */
  async emitHeartbeat(beat: Heartbeat): Promise<void> {
    const consumer = this.heartbeatConsumers[0];
    await consumer?.(beat);
  }

  async dispatchWorkflowTask(task: WorkflowTask): Promise<void> {
    if (!this.worker) throw new Error('no workflow worker registered (serveWorkflow)');
    const decision = await this.worker(task);
    // THE CRUX of the multi-instance bug: deliver the turn's decision to EXACTLY ONE consumer, and —
    // when more than one instance is subscribed — prefer a NON-dispatcher (index ≥ 1; the dispatcher
    // subscribed first, at index 0). The legacy in-memory mechanism resolved a `pending` promise held
    // ONLY by the dispatcher, so a decision handed to another instance was silently DROPPED. The
    // durable fix looks the run up by `decision.runId` on whatever instance receives it and applies it.
    const index = this.decisionConsumers.length > 1 ? 1 : 0;
    const consumer = this.decisionConsumers[index];
    setImmediate(() => void consumer?.(decision));
  }

  onDecision(handler: (decision: WorkflowDecision) => Promise<void>): void {
    this.decisionConsumers.push(handler);
  }

  /** Workflow step lifecycle: point-to-point to one instance (each event is persisted once). */
  async dispatchStepEvent(_event: WorkflowStepEvent): Promise<void> {
    // Not exercised by the regression test; the gather body emits no live step events. Present so the
    // surface mirrors a real broker transport.
  }

  // Control plane: broadcast to every registered handler (the engine dedupes by `from`), mirroring how
  // a real broker echoes a publish to all subscribers.
  async publishControl(msg: ControlMessage): Promise<void> {
    for (const handler of this.controlHandlers) handler(msg);
  }

  onControl(handler: (msg: ControlMessage) => void): void {
    this.controlHandlers.add(handler);
  }
}
