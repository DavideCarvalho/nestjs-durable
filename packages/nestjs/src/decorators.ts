import { type StepError, WORKFLOW_NAME_KEY, type WorkflowRef } from '@dudousxd/nestjs-durable-core';
import 'reflect-metadata';

export const WORKFLOW_METADATA = Symbol('nestjs-durable:workflow');

export interface WorkflowMeta {
  name: string;
  version: string;
  /** The workflow this workflow's dead runs route to (a name or a class). See `WorkflowOptions`. */
  deadLetterWorkflow?: WorkflowRef;
}

export interface WorkflowOptions {
  name: string;
  version?: string;
  /**
   * Route this workflow's dead-lettered runs to another **registered** workflow — by class
   * (`deadLetterWorkflow: CheckoutDlqWorkflow`, refactor-safe) or by name for a cross-runtime
   * handler. For a handler co-located on the same class, prefer an inline `@DeadLetter()` method
   * instead — it takes precedence, and declaring both is a boot-time error. The handler receives a
   * {@link DeadLetter} payload, idempotent by a `dlq:<runId>` id.
   */
  deadLetterWorkflow?: WorkflowRef;
}

/**
 * Marks a provider class as a durable workflow. Its `run(ctx, input)` method becomes the
 * workflow function the engine executes and replays.
 */
export function Workflow(options: WorkflowOptions): ClassDecorator {
  return (target) => {
    const meta: WorkflowMeta = {
      name: options.name,
      version: options.version ?? '1',
      deadLetterWorkflow: options.deadLetterWorkflow,
    };
    Reflect.defineMetadata(WORKFLOW_METADATA, meta, target);
    // Stamp the registered name so this class can be used as a typed workflow ref (ctx.child,
    // engine.start, deadLetterWorkflow) and resolved back to its name via `workflowName`.
    Object.defineProperty(target, WORKFLOW_NAME_KEY, {
      value: options.name,
      configurable: true,
    });
  };
}

// biome-ignore lint/complexity/noBannedTypes: matches reflect-metadata's class target type
export function getWorkflowMeta(target: Function): WorkflowMeta | undefined {
  return Reflect.getMetadata(WORKFLOW_METADATA, target) as WorkflowMeta | undefined;
}

export const DURABLE_STEP_METADATA = Symbol('nestjs-durable:step-handler');

export interface DurableStepMeta {
  name: string;
}

/**
 * Marks a provider method as the handler for a remote step `name`. An in-process transport
 * (e.g. the event-emitter transport) routes dispatched tasks to it. The method's single
 * argument is the step input; its return value is the step output.
 */
export function DurableStep(name: string): MethodDecorator {
  return (_target, _propertyKey, descriptor: PropertyDescriptor) => {
    const meta: DurableStepMeta = { name };
    Reflect.defineMetadata(DURABLE_STEP_METADATA, meta, descriptor.value as object);
    return descriptor;
  };
}

// biome-ignore lint/complexity/noBannedTypes: reflect-metadata reads from the method function
export function getDurableStepMeta(method: Function): DurableStepMeta | undefined {
  return Reflect.getMetadata(DURABLE_STEP_METADATA, method) as DurableStepMeta | undefined;
}

export const DEAD_LETTER_METADATA = Symbol('nestjs-durable:dead-letter');

/**
 * The payload a dead-letter handler receives: the dead run's id, its workflow, the input it was
 * started with (typed via `TInput`), and the failure that killed it.
 */
export interface DeadLetter<TInput = unknown> {
  /** Id of the run that was dead-lettered (inspectable + retriable in the dashboard). */
  deadRunId: string;
  /** Name of the workflow whose run died. */
  workflow: string;
  /** The original input the dead run was started with. */
  input: TInput;
  /** The structured error that moved the run to `dead`, when known. */
  error?: StepError;
}

/**
 * Marks a method on a `@Workflow` class as that workflow's **inline dead-letter handler**. When a
 * run of the workflow is moved to `dead` (exceeded `maxRecoveryAttempts`), this method runs — as a
 * durable workflow itself, auto-registered as `<workflow>.dlq` with a `dlq:<runId>` id — receiving a
 * {@link DeadLetter} payload. It shares the class's injected dependencies, so the handler lives in
 * the same file as the workflow it protects.
 *
 * Takes precedence over `@Workflow({ deadLetterWorkflow })` and the module-level `deadLetterWorkflow`
 * default. The method signature is `(ctx, dead)` — the same `ctx` a workflow `run` gets.
 */
export function DeadLetter(): MethodDecorator {
  return (_target, _propertyKey, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(DEAD_LETTER_METADATA, true, descriptor.value as object);
    return descriptor;
  };
}

// biome-ignore lint/complexity/noBannedTypes: reflect-metadata reads from the method function
export function isDeadLetterHandler(method: Function): boolean {
  return Reflect.getMetadata(DEAD_LETTER_METADATA, method) === true;
}
