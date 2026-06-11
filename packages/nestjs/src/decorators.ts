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
