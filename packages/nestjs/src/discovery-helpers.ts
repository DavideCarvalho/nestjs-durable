import type { StepLogger, WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { getDurableStepMeta, getWorkflowMeta } from './decorators';
import type { DurableStepMeta, WorkflowMeta } from './decorators';
import { originOfProvider } from './origin';
import { schemaParser } from './schema-parse';

export interface WorkflowInstance {
  run(ctx: WorkflowCtx, input: unknown): Promise<unknown>;
}

/**
 * Walks every provider that carries `@Workflow` metadata and invokes
 * `register(meta, instance, origin)`.
 *
 * `origin` is the package that declared the workflow class ({@link originOfProvider}), derived from
 * the provider wrapper — this is the ONE path every `@Workflow` in the app reaches, whichever role
 * the app runs in, so a lib that has never heard of the feature is attributed anyway. It is
 * `undefined` when the derivation could not answer confidently; the engine-side registrar
 * (`WorkflowRegistrar`) reports those at boot, and their runs carry no origin rather than a guess.
 *
 * Guards applied (same as both registrars):
 *   - null / non-object provider instances are skipped
 *   - providers without `@Workflow` metadata are skipped
 *   - a `@Workflow` provider that has no `run` method throws at boot
 */
export function scanWorkflows(
  discovery: DiscoveryService,
  register: (meta: WorkflowMeta, instance: WorkflowInstance, origin: string | undefined) => void,
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
    register(meta, workflow, originOfProvider(wrapper));
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
 * this is where `@Step`'s optional `input`/`output` schemas are enforced: `input` validates
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
      const parseInput =
        meta.input && schemaParser(meta.input, 'input', `step "${meta.name}" input`);
      const parseOutput =
        meta.output && schemaParser(meta.output, 'output', `step "${meta.name}" output`);
      const handler = async (input: unknown, log: StepLogger): Promise<unknown> => {
        const validInput = parseInput ? await parseInput(input) : input;
        const output = await boundMethod.call(instance, validInput, log);
        return parseOutput ? parseOutput(output) : output;
      };
      register(meta, handler);
    }
  }
}
