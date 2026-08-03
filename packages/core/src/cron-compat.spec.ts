import { describe, expect, it } from 'vitest';
import { type CronOptions, resolveCronParse } from './cron-compat';

/**
 * These fakes stand in for the two cron-parser majors.
 *
 * The point is to pin the *entry-point selection*, which is the thing that broke:
 * the peer range advertises `^4.0.0 || ^5.0.0`, but only one major can be
 * installed at a time, so the suite that runs against the dev-installed one can
 * never catch the other being unreachable. Shapes rather than installs is what
 * makes both majors testable in the same run.
 */
const FIRE = new Date('2026-01-02T03:04:00.000Z');
const fire = { prev: () => ({ toDate: () => FIRE }) };

/** v4's export is a *function* carrying `parseExpression` — not an object. */
function v4Module(seen: { expr?: string; options?: CronOptions }) {
  const module_ = (() => undefined) as unknown as Record<string, unknown>;
  module_.parseExpression = (expr: string, options: CronOptions) => {
    seen.expr = expr;
    seen.options = options;
    return fire;
  };
  return module_;
}

/** v5 replaced it with `CronExpressionParser.parse`. */
function v5Module(seen: { expr?: string; options?: CronOptions }) {
  return {
    CronExpressionParser: {
      parse: (expr: string, options: CronOptions) => {
        seen.expr = expr;
        seen.options = options;
        return fire;
      },
    },
  };
}

describe('resolveCronParse', () => {
  it('reads a cron expression through v4 parseExpression', () => {
    const seen: { expr?: string; options?: CronOptions } = {};
    const parse = resolveCronParse(v4Module(seen));
    expect(parse).toBeDefined();

    const options = { currentDate: new Date(0), tz: 'UTC' };
    expect(parse?.('0 0 * * *', options).prev().toDate()).toEqual(FIRE);
    expect(seen.expr).toBe('0 0 * * *');
    expect(seen.options).toEqual(options);
  });

  it('reads a cron expression through v5 CronExpressionParser.parse', () => {
    const seen: { expr?: string; options?: CronOptions } = {};
    const parse = resolveCronParse(v5Module(seen));
    expect(parse).toBeDefined();

    const options = { currentDate: new Date(0), tz: 'America/Sao_Paulo' };
    expect(parse?.('*/5 * * * *', options).prev().toDate()).toEqual(FIRE);
    expect(seen.expr).toBe('*/5 * * * *');
    // The timezone has to survive the hop: evaluating in the wrong zone shifts
    // the fire time, and the fire time is the run id a schedule is keyed on.
    expect(seen.options).toEqual(options);
  });

  it('unwraps an ESM namespace that carries the module under default', () => {
    const seen: { expr?: string; options?: CronOptions } = {};
    expect(resolveCronParse({ default: v5Module(seen) })).toBeDefined();
    expect(resolveCronParse({ default: v4Module(seen) })).toBeDefined();
  });

  it('reports nothing usable rather than guessing, for an unknown shape', () => {
    expect(resolveCronParse({})).toBeUndefined();
    expect(resolveCronParse(undefined)).toBeUndefined();
    expect(resolveCronParse(null)).toBeUndefined();
    // A `CronExpressionParser` without a callable `parse` is a shape nobody can
    // use; falling through to it would throw "parse is not a function" from
    // inside the scheduler instead of naming the real problem.
    expect(resolveCronParse({ CronExpressionParser: {} })).toBeUndefined();
  });
});
