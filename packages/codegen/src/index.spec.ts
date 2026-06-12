import { describe, expect, it } from 'vitest';
import { nestjsDurableCodegen } from './index';

describe('nestjsDurableCodegen', () => {
  it('injects the durable dashboard routes (preserving existing ones)', () => {
    const existing = [
      {
        method: 'GET' as const,
        path: '/api/things',
        name: 'things.list',
        params: [],
        contract: { contractSource: { query: null, body: null, response: 'unknown' } },
      },
    ];
    const out = nestjsDurableCodegen().transformRoutes(existing);
    const names = out.map((r) => r.name);
    expect(names).toContain('things.list'); // existing kept
    expect(names).toEqual(
      expect.arrayContaining([
        'durable.listRuns',
        'durable.getRun',
        'durable.retry',
        'durable.cancel',
      ]),
    );
    const getRun = out.find((r) => r.name === 'durable.getRun');
    expect(getRun?.path).toBe('/durable/api/runs/:id');
    expect(getRun?.params).toEqual([{ name: 'id', source: 'path' }]);
  });

  it('honors basePath and namespace', () => {
    const out = nestjsDurableCodegen({ basePath: '/api/durable', name: 'wf' }).transformRoutes([]);
    expect(out[0]?.path).toBe('/api/durable/runs');
    expect(out.every((r) => r.name.startsWith('wf.'))).toBe(true);
  });
});
