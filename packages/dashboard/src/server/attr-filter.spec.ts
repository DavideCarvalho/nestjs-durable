import { describe, expect, it } from 'vitest';
import { parseAttrFilters } from './attr-filter';

describe('parseAttrFilters', () => {
  it('parses a single key:op:value and coerces the value type', () => {
    expect(parseAttrFilters('amount:gte:200')).toEqual([{ key: 'amount', op: 'gte', value: 200 }]);
    expect(parseAttrFilters('tier:eq:pro')).toEqual([{ key: 'tier', op: 'eq', value: 'pro' }]);
    expect(parseAttrFilters('vip:eq:true')).toEqual([{ key: 'vip', op: 'eq', value: true }]);
  });

  it('parses repeated params into ANDed filters and preserves colons in the value', () => {
    expect(parseAttrFilters(['amount:lt:300', 'ref:eq:a:b'])).toEqual([
      { key: 'amount', op: 'lt', value: 300 },
      { key: 'ref', op: 'eq', value: 'a:b' },
    ]);
  });

  it('skips malformed entries and returns undefined when nothing valid remains', () => {
    expect(parseAttrFilters('amount:badop:1')).toBeUndefined();
    expect(parseAttrFilters('nope')).toBeUndefined();
    expect(parseAttrFilters(undefined)).toBeUndefined();
  });
});
