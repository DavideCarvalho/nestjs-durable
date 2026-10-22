import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import type { WorkflowMeta } from './decorators';
import { schemaParser } from './schema-parse';

type WorkflowBody = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;

/**
 * The `@Workflow({ input, output, validateInput })` contract, split into the two places it applies.
 *
 * - `validateAtStart` is handed to the engine, which calls it in `start` before any run is created:
 *   the input schema must parse, then `validateInput` must not throw. Its result is discarded — the
 *   run stores the input as it was sent.
 * - `wrap` turns `run(ctx, input)` into the body every role registers (inline, in-app worker, thin
 *   worker): the stored input is parsed before the body runs and the returned value is parsed before
 *   it becomes the run's output. It wraps the BODY, not `start`, because the body is what runs on
 *   every turn — including a replay on another process — so every turn sees the same parsed value,
 *   even one (a `Date`, a DTO instance) the stored JSON can't carry.
 */
export function workflowIo(meta: WorkflowMeta): {
  validateAtStart: ((input: unknown) => Promise<void>) | undefined;
  wrap(body: WorkflowBody): WorkflowBody;
} {
  const parseInput =
    meta.input && schemaParser(meta.input, 'input', `workflow "${meta.name}" input`);
  const parseOutput =
    meta.output && schemaParser(meta.output, 'output', `workflow "${meta.name}" output`);
  const validateInput = meta.validateInput;
  return {
    validateAtStart:
      parseInput || validateInput
        ? async (input) => {
            if (parseInput) await parseInput(input);
            await validateInput?.(input);
          }
        : undefined,
    wrap: (body) =>
      !parseInput && !parseOutput
        ? body
        : async (ctx, input) => {
            const output = await body(ctx, parseInput ? await parseInput(input) : input);
            return parseOutput ? parseOutput(output) : output;
          },
  };
}
