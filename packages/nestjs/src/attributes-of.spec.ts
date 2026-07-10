import 'reflect-metadata';
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { z } from 'zod';
import { attributesOf } from './attributes-of';
import { Workflow } from './decorators';

const orderAttrs = z.object({
  tier: z.enum(['free', 'pro']),
  amount: z.number(),
});

describe('attributesOf', () => {
  it("reads a run's valid, schema-conformant attributes typed to the class", () => {
    @Workflow({ name: 'attrs-of-valid', searchAttributes: orderAttrs })
    class ValidWorkflow {
      async run(ctx: WorkflowCtx<{ tier: 'free' | 'pro'; amount: number }>, _input: unknown) {
        await ctx.upsertSearchAttributes({ tier: 'pro' });
      }
    }

    const attrs = attributesOf(ValidWorkflow, { searchAttributes: { tier: 'pro', amount: 10 } });
    expect(attrs).toEqual({ tier: 'pro', amount: 10 });
  });

  it('lenient read: invalid/legacy stored attributes resolve to {} rather than throwing', () => {
    @Workflow({ name: 'attrs-of-invalid', searchAttributes: orderAttrs })
    class InvalidWorkflow {
      async run() {
        return 'ok';
      }
    }

    const attrs = attributesOf(InvalidWorkflow, {
      searchAttributes: { tier: 'legacy-value', amount: 'not-a-number' },
    });
    expect(attrs).toEqual({});
  });

  it('lenient read: a run with searchAttributes: null resolves to {}', () => {
    @Workflow({ name: 'attrs-of-null', searchAttributes: orderAttrs })
    class NullWorkflow {
      async run() {
        return 'ok';
      }
    }

    const attrs = attributesOf(NullWorkflow, { searchAttributes: null });
    expect(attrs).toEqual({});
  });

  it('lenient read: a run with no searchAttributes at all resolves to {}', () => {
    @Workflow({ name: 'attrs-of-absent', searchAttributes: orderAttrs })
    class AbsentWorkflow {
      async run() {
        return 'ok';
      }
    }

    const attrs = attributesOf(AbsentWorkflow, {});
    expect(attrs).toEqual({});
  });

  it('throws a teaching message when the class declares no searchAttributes schema', () => {
    @Workflow({ name: 'attrs-of-no-schema' })
    class NoSchemaWorkflow {
      async run() {
        return 'ok';
      }
    }

    expect(() => attributesOf(NoSchemaWorkflow, {})).toThrow(/attrs-of-no-schema/);
    expect(() => attributesOf(NoSchemaWorkflow, {})).toThrow(/searchAttributes/);
  });

  it('throws naming the class when it is not a @Workflow class at all', () => {
    class UndecoratedWorkflow {
      async run() {
        return 'ok';
      }
    }

    expect(() => attributesOf(UndecoratedWorkflow, {})).toThrow(/UndecoratedWorkflow/);
    expect(() => attributesOf(UndecoratedWorkflow, {})).toThrow(/@Workflow/);
  });
});
