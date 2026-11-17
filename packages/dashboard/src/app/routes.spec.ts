import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash, sameRoute } from './routes';

describe('routes', () => {
  it('parses every page from the hash, the runs board by default', () => {
    expect(parseRoute('')).toEqual({ page: 'runs' });
    expect(parseRoute('#/run/ord%2F1')).toEqual({ page: 'runs', runId: 'ord/1' });
    expect(parseRoute('#/workflow/checkout')).toEqual({ page: 'workflow', workflow: 'checkout' });
    expect(parseRoute('#/workers')).toEqual({ page: 'workers' });
    expect(parseRoute('#/schedules')).toEqual({ page: 'schedules' });
    expect(parseRoute('#/nope')).toEqual({ page: 'runs' });
  });

  it('falls back to the runs board on a malformed escape instead of throwing', () => {
    expect(parseRoute('#/run/%E0%A4%A')).toEqual({ page: 'runs' });
    expect(parseRoute('#/workflow/%')).toEqual({ page: 'runs' });
  });

  it('round-trips through routeHash (the run deep link stays #/run/<id>)', () => {
    for (const hash of ['#/run/ord%2F1', '#/workflow/checkout', '#/workers', '#/schedules']) {
      expect(routeHash(parseRoute(hash))).toBe(hash);
    }
    expect(routeHash({ page: 'runs' })).toBe('');
  });

  it('decides the page by the path half: the query is the runs board filters', () => {
    expect(parseRoute('#?status=failed')).toEqual({ page: 'runs' });
    expect(parseRoute('#/run/r1?status=failed&tag=vip')).toEqual({ page: 'runs', runId: 'r1' });
    expect(parseRoute('#/workers?status=failed')).toEqual({ page: 'workers' });
    expect(parseRoute('#/workflow/checkout?x=1')).toEqual({
      page: 'workflow',
      workflow: 'checkout',
    });
    expect(sameRoute(parseRoute('#/run/r1'), parseRoute('#/run/r1?status=failed'))).toBe(true);
    expect(sameRoute(parseRoute('#/run/r1'), parseRoute('#/run/r2'))).toBe(false);
  });
});
