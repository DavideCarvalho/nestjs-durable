import { capability } from '@dudousxd/nestjs-diagnostics';
import { describe, expect, it } from 'vitest';
import { CONTEXT_ACCESSOR } from './tokens';

describe('nestjs-durable consumes context:accessor via the protocol', () => {
  it('CONTEXT_ACCESSOR is the canonical cross-lib capability symbol', () => {
    expect(CONTEXT_ACCESSOR).toBe(capability('context', 'accessor'));
    expect(CONTEXT_ACCESSOR).toBe(Symbol.for('@dudousxd/nestjs-context:accessor'));
  });
});
