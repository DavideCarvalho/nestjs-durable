import type {
  RemoteTask,
  StepResult,
  WorkflowDecision,
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

  constructor(options: { workflowGroup?: string; stepGroup?: string } = {}) {
    this.workflows = new WorkflowWorker(options.workflowGroup);
    this.steps = new StepWorker(options.stepGroup);
  }

  /** Register `fn` as the workflow `name`. Chainable. */
  registerWorkflow(name: string, fn: WorkflowFn): this {
    this.workflows.register(name, fn);
    return this;
  }

  /** Register `handler` as the step `name`. Chainable. */
  registerStep<I = unknown, O = unknown>(name: string, handler: StepHandler<I, O>): this {
    this.steps.register(name, handler);
    return this;
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
