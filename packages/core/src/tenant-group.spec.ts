import { describe, expect, it } from 'vitest';
import { sanitizeQueueToken, tenantGroup } from './tenant-group';

describe('tenantGroup', () => {
  it('returns the bare group for an undefined tenant', () => {
    expect(tenantGroup('processing', undefined)).toBe('processing');
  });

  it('returns the bare group for the "default" tenant', () => {
    expect(tenantGroup('processing', 'default')).toBe('processing');
  });

  it('returns the bare group for an empty-string tenant', () => {
    expect(tenantGroup('processing', '')).toBe('processing');
  });

  it('suffixes the group with the tenant for any other tenant', () => {
    expect(tenantGroup('processing', 'davi-local')).toBe('processing@davi-local');
  });
});

describe('sanitizeQueueToken', () => {
  it('replaces every colon with a hyphen (BullMQ forbids ":" in queue names)', () => {
    expect(sanitizeQueueToken('extraction:page')).toBe('extraction-page');
  });

  it('leaves "." as-is (legal in a BullMQ queue name)', () => {
    expect(sanitizeQueueToken('payments.charge')).toBe('payments.charge');
  });
});
