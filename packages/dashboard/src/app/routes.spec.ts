import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash } from './routes';

describe('routes', () => {
  it('parses every page from the hash, the runs board by default', () => {
    expect(parseRoute('')).toEqual({ page: 'runs' });
    expect(parseRoute('#/run/ord%2F1')).toEqual({ page: 'runs', runId: 'ord/1' });
    expect(parseRoute('#/workflow/checkout')).toEqual({ page: 'workflow', workflow: 'checkout' });
    expect(parseRoute('#/workers')).toEqual({ page: 'workers' });
    expect(parseRoute('#/schedules')).toEqual({ page: 'schedules' });
    expect(parseRoute('#/nope')).toEqual({ page: 'runs' });
  });

  it('round-trips through routeHash (the run deep link stays #/run/<id>)', () => {
    for (const hash of ['#/run/ord%2F1', '#/workflow/checkout', '#/workers', '#/schedules']) {
      expect(routeHash(parseRoute(hash))).toBe(hash);
    }
    expect(routeHash({ page: 'runs' })).toBe('');
  });
});
