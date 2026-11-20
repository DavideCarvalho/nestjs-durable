import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import type { WorkflowMeta } from './decorators';
import { schemaParser } from './schema-parse';

type WorkflowBody = (ctx: WorkflowCtx, input: unknown) => Promise<unknown>;

/**
 * The `@Workflow({ input, output, validateInput })` contract, split into the two places it applies.
 *
 * - `parseInput` and `validateParsed` are handed to the engine (and a tenant's start policy), which
 *   checks the input in `start` before any run is created: it parses the input once, then runs
 *   `validateInput` on the parsed value, and the `singleton` and `concurrency` keys read that value
 *   too. The parsed value is then discarded — the run stores the input as it was sent. Each turn's
 *   singleton admission parses the stored input again for its key.
 * - `wrap` turns `run(ctx, input)` into the body every role registers (inline, in-app worker, thin
 *   worker): the stored input is parsed before the body runs and the returned value is parsed before
 *   it becomes the run's output. It wraps the BODY, not `start`, because the body is what runs on
 *   every turn — including a replay on another process — so every turn sees the same parsed value,
 *   even one (a `Date`, a DTO instance) the stored JSON can't carry.
 */
export function workflowIo(meta: WorkflowMeta): {
  /** The input schema's parser, or undefined without one. Handed to the engine (and a tenant's
   *  start policy) with {@link validateParsed}: it parses once at start, then `validateInput` and
   *  the `singleton` and `concurrency` keys read the parsed value, the one `run(ctx, input)` gets. */
  parseInput: ((input: unknown) => Promise<unknown>) | undefined;
  /** `@Workflow({ validateInput })` alone, for a caller that already parsed with
   *  {@link parseInput}. */
  validateParsed: ((input: unknown) => void | Promise<void>) | undefined;
  wrap(body: WorkflowBody): WorkflowBody;
} {
  const parseInput =
    meta.input && schemaParser(meta.input, 'input', `workflow "${meta.name}" input`);
  const parseOutput =
    meta.output && schemaParser(meta.output, 'output', `workflow "${meta.name}" output`);
  const validateInput = meta.validateInput;
  return {
    parseInput: parseInput || undefined,
    validateParsed: validateInput,
    wrap: (body) =>
      !parseInput && !parseOutput
        ? body
        : async (ctx, input) => {
            const output = await body(ctx, parseInput ? await parseInput(input) : input);
            return parseOutput ? parseOutput(output) : output;
          },
  };
}
