import type { z } from 'zod';
import type { RemoteStepDef, StepOptions } from './interfaces';

export interface RemoteStepConfig<TInput, TOutput> extends StepOptions {
  name: string;
  /** Optional isolation partition; routing is by `name`. See {@link RemoteStepDef.partition}. */
  partition?: string;
  input: z.ZodType<TInput>;
  output: z.ZodType<TOutput>;
}

/**
 * Defines a typed handle to a step that runs on a remote worker. Call it from a workflow with
 * `ctx.remote(step, input)`; a worker registers a handler under the same `name`, which is also
 * the routing key — `partition` is an optional isolation suffix, not a separate declared group.
 */
export function remoteStep<TInput, TOutput>(
  config: RemoteStepConfig<TInput, TOutput>,
): RemoteStepDef<TInput, TOutput> {
  const { partition, ...rest } = config;
  return {
    ...rest,
    ...(partition !== undefined ? { partition } : {}),
    __remote: true,
  };
}
