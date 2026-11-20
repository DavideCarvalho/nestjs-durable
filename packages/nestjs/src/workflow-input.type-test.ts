import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { z } from 'zod';
import { Workflow, type WorkflowOptions } from './decorators';
import type { InferWorkflowInput } from './schema-parse';

// Compile-time only: with `@Workflow({ input })`, the `singleton` and `concurrency` keys and
// `validateInput` take the schema's PARSED type; without a schema they take `unknown`.

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const assertType = <T extends true>(_: T): void => undefined;

const SyncInput = z.object({
  companyId: z.string(),
  at: z.coerce.date(),
  limit: z.string().transform((s) => Number(s)),
});

// The parsed (output) type, not the input type: `at` is a Date, `limit` a number.
assertType<
  Equals<InferWorkflowInput<typeof SyncInput>, { companyId: string; at: Date; limit: number }>
>(true);
assertType<Equals<InferWorkflowInput<undefined>, unknown>>(true);

class SyncDto {
  companyId!: string;
}
assertType<Equals<InferWorkflowInput<typeof SyncDto>, SyncDto>>(true);

@Workflow({
  name: 'typed-keys',
  input: SyncInput,
  singleton: {
    key: (input) => {
      assertType<Equals<typeof input, { companyId: string; at: Date; limit: number }>>(true);
      return `company:${input.companyId}:${input.at.toISOString()}`;
    },
  },
  concurrency: { key: (input) => `tenant:${input.companyId}`, limit: 4 },
  validateInput: (input) => {
    if (input.limit < 0) throw new Error('negative');
  },
})
export class TypedKeys {
  async run(_ctx: WorkflowCtx, input: InferWorkflowInput<typeof SyncInput>) {
    return input.companyId;
  }
}

@Workflow({
  name: 'typed-keys-wrong-property',
  input: SyncInput,
  // @ts-expect-error — `tenantId` is not on the parsed input
  singleton: { key: (input) => `t:${input.tenantId}` },
})
export class WrongProperty {
  async run() {}
}

@Workflow({
  name: 'typed-keys-wrong-concurrency',
  input: SyncInput,
  // @ts-expect-error — `limit` is a number after parsing, not a string
  concurrency: { key: (input) => input.limit.toUpperCase(), limit: 1 },
})
export class WrongConcurrency {
  async run() {}
}

@Workflow({
  name: 'untyped-keys',
  singleton: {
    key: (input) => {
      assertType<Equals<typeof input, unknown>>(true);
      return String(input);
    },
  },
  concurrency: {
    key: (input) => {
      assertType<Equals<typeof input, unknown>>(true);
      return undefined;
    },
    limit: 1,
  },
})
export class UntypedKeys {
  async run() {}
}

@Workflow({
  name: 'untyped-keys-cast',
  // Today's form keeps compiling: a key written for `unknown` with a cast.
  singleton: { key: (input) => `company:${(input as { companyId: string }).companyId}` },
})
export class UntypedCast {
  async run() {}
}

@Workflow({
  name: 'untyped-keys-no-access',
  // @ts-expect-error — without a schema the input is `unknown`
  singleton: { key: (input) => input.companyId },
})
export class UntypedNoAccess {
  async run() {}
}

@Workflow({
  name: 'typed-keys-annotated',
  input: SyncInput,
  // An explicit annotation with the parsed type is accepted.
  singleton: { key: (input: { companyId: string }) => input.companyId },
})
export class Annotated {
  async run() {}
}

// `WorkflowOptions` written without a type argument accepts any `input` schema, as before, and its
// callbacks take `unknown` (the schema is not tracked through an annotation).
const annotated: WorkflowOptions = {
  name: 'annotated-options',
  input: SyncInput,
  singleton: {
    key: (input) => {
      assertType<Equals<typeof input, unknown>>(true);
      return 'k';
    },
  },
};
assertType<Equals<Parameters<NonNullable<typeof annotated.validateInput>>[0], unknown>>(true);

@Workflow(annotated)
export class FromAnnotatedOptions {
  async run() {}
}

// An interface that extends it, as an app's own options type might.
interface AppWorkflowOptions extends WorkflowOptions {
  team: string;
}
const extended: AppWorkflowOptions = { name: 'extended-options', team: 'ops', input: SyncInput };

@Workflow(extended)
export class FromExtendedOptions {
  async run() {}
}

// With an explicit type argument the callbacks are typed again.
const explicit: WorkflowOptions<typeof SyncInput> = {
  name: 'explicit-options',
  input: SyncInput,
  singleton: { key: (input) => input.companyId },
};

@Workflow(explicit)
export class FromExplicitOptions {
  async run() {}
}
