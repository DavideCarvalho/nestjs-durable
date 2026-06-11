import 'reflect-metadata';

export const WORKFLOW_METADATA = Symbol('nestjs-durable:workflow');

export interface WorkflowMeta {
  name: string;
  version: string;
}

export interface WorkflowOptions {
  name: string;
  version?: string;
}

/**
 * Marks a provider class as a durable workflow. Its `run(ctx, input)` method becomes the
 * workflow function the engine executes and replays.
 */
export function Workflow(options: WorkflowOptions): ClassDecorator {
  return (target) => {
    const meta: WorkflowMeta = { name: options.name, version: options.version ?? '1' };
    Reflect.defineMetadata(WORKFLOW_METADATA, meta, target);
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
