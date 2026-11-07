import { describe, expect, it } from 'vitest';
import { nextRRuleFireMs, parseRRule, prevRRuleFireMs } from './rrule';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The first `n` occurrences after `fromIso`. */
function take(rule: string, fromIso: string, n: number, tz = 'UTC'): Array<string | null> {
  const parsed = parseRRule(rule, tz);
  const out: Array<string | null> = [];
  let cursor = at(fromIso);
  for (let i = 0; i < n; i++) {
    const next = nextRRuleFireMs(parsed, cursor);
    out.push(iso(next));
    if (next === null) break;
    cursor = next;
  }
  return out;
}

describe('rrule', () => {
  it('weekly on Mondays at 08:00 in São Paulo (UTC-3)', () => {
    expect(
      take('FREQ=WEEKLY;BYDAY=MO;BYHOUR=8', '2026-11-04T12:00:00Z', 2, 'America/Sao_Paulo'),
    ).toEqual(['2026-11-09T11:00:00.000Z', '2026-11-16T11:00:00.000Z']);
  });

  it('accepts the RRULE: prefix and a DTSTART line', () => {
    expect(
      take('DTSTART:20261101T093000\nRRULE:FREQ=DAILY;INTERVAL=2', '2026-11-01T00:00:00Z', 3),
    ).toEqual(['2026-11-01T09:30:00.000Z', '2026-11-03T09:30:00.000Z', '2026-11-05T09:30:00.000Z']);
  });

  it('monthly on the last Friday at 17:00', () => {
    expect(take('FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17', '2026-11-01T00:00:00Z', 3)).toEqual([
      '2026-11-27T17:00:00.000Z',
      '2026-12-25T17:00:00.000Z',
      '2027-01-29T17:00:00.000Z',
    ]);
  });

  it('monthly on the first Monday, and on the last day of the month', () => {
    expect(take('FREQ=MONTHLY;BYDAY=1MO', '2026-11-03T00:00:00Z', 2)).toEqual([
      '2026-12-07T00:00:00.000Z',
      '2027-01-04T00:00:00.000Z',
    ]);
    expect(
      take('FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=23;BYMINUTE=59', '2027-01-31T23:59:00Z', 2),
    ).toEqual(['2027-02-28T23:59:00.000Z', '2027-03-31T23:59:00.000Z']);
  });

  it('yearly with BYMONTH and BYMONTHDAY', () => {
    expect(take('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2026-01-01T00:00:00Z', 2)).toEqual([
      '2028-02-29T00:00:00.000Z',
      '2032-02-29T00:00:00.000Z',
    ]);
  });

  it('every 6 hours and every 15 minutes', () => {
    expect(take('FREQ=HOURLY;INTERVAL=6', '2026-11-01T01:00:00Z', 3)).toEqual([
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T12:00:00.000Z',
      '2026-11-01T18:00:00.000Z',
    ]);
    expect(take('FREQ=MINUTELY;INTERVAL=15', '2026-11-01T01:07:00Z', 2)).toEqual([
      '2026-11-01T01:15:00.000Z',
      '2026-11-01T01:30:00.000Z',
    ]);
  });

  it('COUNT and UNTIL end the rule', () => {
    expect(take('DTSTART:20261101T080000Z\nFREQ=DAILY;COUNT=2', '2026-10-01T00:00:00Z', 3)).toEqual(
      ['2026-11-01T08:00:00.000Z', '2026-11-02T08:00:00.000Z', null],
    );
    expect(take('FREQ=DAILY;BYHOUR=8;UNTIL=20261102T080000Z', '2026-11-01T00:00:00Z', 3)).toEqual([
      '2026-11-01T08:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
      null,
    ]);
  });

  it('skips a local time that does not exist (DST spring-forward) and keeps the others', () => {
    // Europe/Warsaw jumps 02:00 → 03:00 on 2026-03-29: 02:30 doesn't exist that day.
    expect(
      take('FREQ=DAILY;BYHOUR=2;BYMINUTE=30', '2026-03-28T00:00:00Z', 2, 'Europe/Warsaw'),
    ).toEqual([
      '2026-03-28T01:30:00.000Z', // CET (UTC+1)
      '2026-03-30T00:30:00.000Z', // CEST (UTC+2); the 29th is skipped
    ]);
  });

  it('prev: the latest occurrence at or before a time', () => {
    const rule = parseRRule('FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9');
    expect(iso(prevRRuleFireMs(rule, at('2026-11-07T00:00:00Z')))).toBe('2026-11-05T09:00:00.000Z');
    expect(iso(prevRRuleFireMs(rule, at('2026-11-05T09:00:00Z')))).toBe('2026-11-05T09:00:00.000Z');
    const counted = parseRRule('DTSTART:20261101T080000Z\nFREQ=DAILY;COUNT=2');
    expect(prevRRuleFireMs(counted, at('2026-10-01T00:00:00Z'))).toBeNull();
  });

  it('refuses what it does not support, by name', () => {
    expect(() => parseRRule('FREQ=SECONDLY')).toThrow(/FREQ=SECONDLY is not supported/);
    expect(() => parseRRule('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO')).toThrow(
      /BYSETPOS is not supported/,
    );
    expect(() => parseRRule('FREQ=WEEKLY;BYDAY=1MO')).toThrow(/needs FREQ=MONTHLY or YEARLY/);
    expect(() => parseRRule('BYDAY=MO')).toThrow(/FREQ is required/);
    expect(() => parseRRule('FREQ=DAILY', 'Mars/Olympus')).toThrow();
  });
});
