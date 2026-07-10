import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { SearchAttributes } from './interfaces';
import { readSearchAttributes } from './search-attributes-schema';
import type { StandardSchemaV1 } from './standard-schema';

const orderAttrs = z.object({
  tier: z.enum(['free', 'pro']),
  amount: z.number(),
});

describe('readSearchAttributes', () => {
  it('returns the typed attributes when the run searchAttributes satisfy the schema', () => {
    const run = { searchAttributes: { tier: 'pro', amount: 42 } };

    expect(readSearchAttributes(orderAttrs, run)).toEqual({ tier: 'pro', amount: 42 });
  });

  it('is lenient on failure — returns {} rather than throwing for old/foreign history', () => {
    const run: { searchAttributes: SearchAttributes } = {
      searchAttributes: { tier: 'pro', amount: 'not-a-number' },
    };

    expect(readSearchAttributes(orderAttrs, run)).toEqual({});
  });

  it('returns {} for a run with no searchAttributes at all', () => {
    expect(readSearchAttributes(orderAttrs, {})).toEqual({});
    expect(readSearchAttributes(orderAttrs, { searchAttributes: undefined })).toEqual({});
  });

  it('throws a clear, non-throwing-on-data error when the schema validator is async', () => {
    const asyncSchema: StandardSchemaV1<unknown, SearchAttributes> = {
      '~standard': {
        version: 1,
        vendor: 'test-async',
        validate: async (value) => ({ value: value as SearchAttributes }),
      },
    };

    expect(() => readSearchAttributes(asyncSchema, { searchAttributes: { a: 1 } })).toThrow(
      /synchronous/,
    );
  });
});
