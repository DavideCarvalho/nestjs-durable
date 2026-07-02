import type { StepLogger, WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { getDurableStepMeta, getWorkflowMeta } from './decorators';
import type { DurableStepMeta, WorkflowMeta } from './decorators';

export interface WorkflowInstance {
  run(ctx: WorkflowCtx, input: unknown): Promise<unknown>;
}

/**
 * Walks every provider that carries `@Workflow` metadata and invokes `register(meta, instance)`.
 *
 * Guards applied (same as both registrars):
 *   - null / non-object provider instances are skipped
 *   - providers without `@Workflow` metadata are skipped
 *   - a `@Workflow` provider that has no `run` method throws at boot
 */
export function scanWorkflows(
  discovery: DiscoveryService,
  register: (meta: WorkflowMeta, instance: WorkflowInstance) => void,
): void {
  for (const wrapper of discovery.getProviders()) {
    const { instance } = wrapper;
    if (!instance || typeof instance !== 'object') continue;
    const meta = getWorkflowMeta(instance.constructor);
    if (!meta) continue;
    const workflow = instance as WorkflowInstance;
    if (typeof workflow.run !== 'function') {
      throw new Error(`@Workflow ${meta.name} must define a run(ctx, input) method`);
    }
    register(meta, workflow);
  }
}

/**
 * Walks every provider method that carries `@Step` metadata and invokes
 * `register(meta, boundHandler)`.
 *
 * Guards applied (same as both registrars):
 *   - null / non-object provider instances are skipped
 *   - non-function methods are skipped
 *   - methods without `@Step` metadata are skipped
 *
 * The handler passed to `register` is already bound to its instance, and is the ONE place a `@Step`
 * method actually runs with real input/output in this package — every registrar
 * (`DurableStepRegistrar`, `InAppWorkerBootstrap`, `ThinStepRegistrar`) funnels through here — so
 * this is where `@Step`'s optional `input`/`output` zod schemas are enforced: `input` validates
 * before the method runs, `output` validates its return value before it's handed back. A bare
 * `@Step()` (no schemas attached) skips both checks — `meta.input`/`meta.output` are `undefined`.
 */
export function scanSteps(
  discovery: DiscoveryService,
  scanner: MetadataScanner,
  register: (
    meta: DurableStepMeta,
    handler: (input: unknown, log: StepLogger) => Promise<unknown>,
  ) => void,
): void {
  for (const wrapper of discovery.getProviders()) {
    const { instance } = wrapper;
    if (!instance || typeof instance !== 'object') continue;
    const prototype = Object.getPrototypeOf(instance);
    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const method = (instance as Record<string, unknown>)[methodName];
      if (typeof method !== 'function') continue;
      const meta = getDurableStepMeta(method);
      if (!meta) continue;
      const boundMethod = method as (input: unknown, log: StepLogger) => unknown;
      const handler = async (input: unknown, log: StepLogger): Promise<unknown> => {
        const validInput = meta.input ? meta.input.parse(input) : input;
        const output = await boundMethod.call(instance, validInput, log);
        return meta.output ? meta.output.parse(output) : output;
      };
      register(meta, handler);
    }
  }
}
