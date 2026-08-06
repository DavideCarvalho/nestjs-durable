import type {
  RemoteTask,
  StepResult,
  WorkflowDecision,
  WorkflowRegistration,
  WorkflowStepEvent,
  WorkflowTask,
} from '@dudousxd/nestjs-durable-core';
import type { StepHandler } from './step-worker';
import { StepWorker } from './step-worker';
import type { WorkflowFn } from './workflow-worker';
import { WorkflowWorker } from './workflow-worker';

/** The default key prefix namespacing the durable queues — matches `BullMQTransport`'s default. */
export const DEFAULT_PREFIX = 'durable';

// --- Queue / channel name helpers ------------------------------------------------------------
//
// These MUST byte-match the TS `BullMQTransport` (see packages/transport-bullmq) so a Node worker
// consumes the very queues a TS engine dispatches on, cross-language with the Python SDK. BullMQ
// queue names must not contain ':' (its Redis key separator), so the queues use '-'. A unit test
// asserts these against the transport's conventions.

/**
 * Fold a logical deployment `namespace` into `prefix`, per the cross-SDK rule (MUST match
 * `BullMQTransport.#effectivePrefix` and Python's `_effective_prefix`): an unset or `"default"`
 * namespace yields the bare prefix (un-namespaced scheme unchanged — production names stable);
 * any other value appends `-<namespace>` so isolated deployments share one Redis without crosstalk.
 */
export function effectivePrefixOf(prefix: string, namespace?: string): string {
  return namespace && namespace !== 'default' ? `${prefix}-${namespace}` : prefix;
}

/** `<prefix>-start-run` — the queue a tenant worker publishes start-run requests onto (P4).
 *  MUST byte-match `BullMQTransport.#startRunName` and the Python SDK's start-run channel. */
export function startRunName(prefix: string): string {
  return `${prefix}-start-run`;
}

/** `<prefix>-tasks-<group>` — the per-group tasks queue the engine dispatches WorkflowTask/RemoteTask on. */
export function tasksName(prefix: string, group: string): string {
  return `${prefix}-tasks-${group}`;
}

/** `<prefix>-results` — the shared queue a step worker publishes its StepResult on. */
export function resultsName(prefix: string): string {
  return `${prefix}-results`;
}

/** `<prefix>-decisions` — the queue a workflow worker publishes its WorkflowDecision on. */
export function decisionsName(prefix: string): string {
  return `${prefix}-decisions`;
}

/** `<prefix>-step-events` — the queue a workflow worker streams local step lifecycle events on. */
export function stepEventsName(prefix: string): string {
  return `${prefix}-step-events`;
}

/** `<prefix>-control` — the Redis pub/sub channel carrying cancellation + live events. */
export function controlChannel(prefix: string): string {
  return `${prefix}-control`;
}

/** `<prefix>-heartbeat` — the Redis pub/sub channel carrying liveness beats (per-step AND run-scoped).
 *  MUST byte-match `BullMQTransport.heartbeatChannel` so the engine's transport receives our beats. */
export function heartbeatChannel(prefix: string): string {
  return `${prefix}-heartbeat`;
}

/** `<prefix>-worker-heartbeat:<group>:<instanceId>` — the TTL'd worker-liveness key. The ':' here is
 *  fine: it's a Redis KEY, not a BullMQ queue name. Matches `BullMQTransport.workerHeartbeatKey`. */
export function workerHeartbeatKey(prefix: string, group: string, instanceId: string): string {
  return `${prefix}-worker-heartbeat:${group}:${instanceId}`;
}

/** `<prefix>-worker-descriptor:<group>:<instanceId>` — the TTL'd full handshake descriptor (design
 *  §7.2), written with the SAME TTL as the heartbeat so a dead worker's advertisement (and every
 *  workflow it announced) expires alongside its liveness key. CROSS-SDK CONTRACT: MUST byte-match
 *  `BullMQTransport.workerDescriptorKey` and the Python SDK's `_descriptor_key`. */
export function workerDescriptorKey(prefix: string, group: string, instanceId: string): string {
  return `${prefix}-worker-descriptor:${group}:${instanceId}`;
}

/**
 * What a worker announces about a registered workflow beyond its name — the announcement fields the
 * REGISTERING side knows. `group` is deliberately absent: it is the queue token the runner
 * subscribes, which the runner derives from the name + its own partition, so letting a registrar
 * declare one would let it claim a queue nothing consumes.
 */
export type WorkflowRegistrationMeta = Omit<WorkflowRegistration, 'name' | 'group'>;

/** The routed output of {@link DurableWorkerRuntime.handleTask}: either a replayed workflow turn's
 *  decision (→ `<prefix>-decisions`) or a step's result (→ `<prefix>-results`). */
export type HandledTask =
  | { kind: 'decision'; decision: WorkflowDecision }
  | { kind: 'result'; result: StepResult };

/**
 * Discriminate a {@link WorkflowTask} from a {@link RemoteTask} purely by shape, so the runner can
 * route a single tasks queue (which carries BOTH — the engine adds `'workflow'` and `'task'` jobs to
 * the same `<prefix>-tasks-<group>` queue) to the right worker.
 *
 * The discriminator is `workflow`: only a WorkflowTask has a `workflow` (the registered workflow
 * name) and a `history` array. A RemoteTask instead has `stepId` + `name` for a single step and NO
 * `workflow`/`history`. Checking `workflow` (string) + `history` (array) is robust to either side
 * carrying extra optional fields (`traceparent`, `priority`, `transport`, …).
 */
export function isWorkflowTask(task: WorkflowTask | RemoteTask): task is WorkflowTask {
  const t = task as Partial<WorkflowTask>;
  return typeof t.workflow === 'string' && Array.isArray(t.history);
}

/** Per-task hooks the BullMQ shell feeds into a replay (live step streaming + cooperative cancel). */
export interface HandleTaskOptions {
  /** Stream a local step's lifecycle (running → completed/failed) — the shell publishes on step-events. */
  onStep?: (event: WorkflowStepEvent) => void;
  /** Whether `runId` was cancelled — lets a replay bail at an op boundary (→ a `cancelled` decision). */
  isCancelled?: (runId: string) => boolean;
}

/**
 * The transport-agnostic core of the durable worker. Holds a {@link WorkflowWorker} (replays workflow
 * turns) and a {@link StepWorker} (runs remote steps), and routes a single inbound task to whichever
 * one its shape selects. Pure — `handleTask` is a function of the task plus the registered
 * workflows/steps — so it's fully unit-testable WITHOUT Redis. The BullMQ shell
 * ({@link import('./redis-runner').runRedisWorker}) is a thin wire layer over this.
 */
export class DurableWorkerRuntime {
  readonly workflows: WorkflowWorker;
  readonly steps: StepWorker;
  /** What each registered workflow announces about itself beyond its name — see
   *  {@link registerWorkflow}. Keyed by name; a workflow registered without meta has no entry, and
   *  is announced as a bare name rather than with invented fields. */
  private readonly workflowMeta = new Map<string, WorkflowRegistrationMeta>();

  constructor(options: { workflowGroup?: string; stepGroup?: string } = {}) {
    this.workflows = new WorkflowWorker(options.workflowGroup);
    this.steps = new StepWorker(options.stepGroup);
  }

  /**
   * Register `fn` as the workflow `name`. Chainable.
   *
   * `meta` is what this worker ANNOUNCES about the workflow beyond its name (design §7.9): its
   * version, the capabilities it demands, and the package that declared it. It is registry metadata
   * only — nothing here changes how the body replays, and omitting it costs only detail in the
   * announcement, never execution. Pass what you actually know: an absent field means "not stated",
   * and a reader is required to treat it that way rather than fill in a default.
   */
  registerWorkflow(name: string, fn: WorkflowFn, meta?: WorkflowRegistrationMeta): this {
    this.workflows.register(name, fn);
    if (meta) this.workflowMeta.set(name, meta);
    return this;
  }

  /** Register `handler` as the step `name`. Chainable. */
  registerStep<I = unknown, O = unknown>(name: string, handler: StepHandler<I, O>): this {
    this.steps.register(name, handler);
    return this;
  }

  /**
   * Every workflow + step name registered on this runtime — the subscription surface a shell (e.g.
   * {@link import('./redis-runner').runRedisWorker}) starts one consumer per (deduped across the
   * union), instead of a single hand-declared group queue.
   */
  registeredNames(): { workflows: string[]; steps: string[] } {
    return { workflows: this.workflows.names, steps: this.steps.names };
  }

  /**
   * What this runtime announces it can EXECUTE: one entry per registered workflow, carrying whatever
   * {@link registerWorkflow} was told about it. No `group` — the runner adds that, because the group
   * is the queue the runner actually subscribed, and only the runner knows it. Only workflows: a step
   * is not addressable from outside a run, so there is nothing to announce it FOR (see the "steps are
   * out of scope" note in core's `handshake/announced`).
   */
  workflowRegistrations(): Array<{ name: string } & WorkflowRegistrationMeta> {
    return this.workflows.names.map((name) => ({ name, ...this.workflowMeta.get(name) }));
  }

  /**
   * Route one inbound task to the right worker and return its typed output. A {@link WorkflowTask}
   * replays a turn → `{ kind: 'decision' }`; a {@link RemoteTask} runs a step → `{ kind: 'result' }`.
   * Never throws on an unknown name: the underlying worker returns a `failed` decision/result (so a
   * misconfigured worker is a recorded failure, not a crashed consumer).
   */
  async handleTask(
    task: WorkflowTask | RemoteTask,
    opts: HandleTaskOptions = {},
  ): Promise<HandledTask> {
    if (isWorkflowTask(task)) {
      const decision = await this.workflows.processTask(task, {
        ...(opts.onStep !== undefined ? { onStep: opts.onStep } : {}),
        ...(opts.isCancelled !== undefined ? { isCancelled: opts.isCancelled } : {}),
      });
      return { kind: 'decision', decision };
    }
    const result = await this.steps.processTask(task);
    return { kind: 'result', result };
  }
}
