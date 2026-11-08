/**
 * RFC 5545 recurrence rules for persisted schedules (`engine.schedules.create({ rrule })`), evaluated
 * in an IANA time zone with no dependency.
 *
 * Accepted text: `FREQ=WEEKLY;BYDAY=MO;BYHOUR=8`, optionally prefixed `RRULE:`, optionally preceded by
 * a `DTSTART:20260105T080000` line (local time in the schedule's zone, or UTC with a trailing `Z`).
 *
 * Supported parts: `FREQ` (`YEARLY`, `MONTHLY`, `WEEKLY`, `DAILY`, `HOURLY`, `MINUTELY`), `INTERVAL`,
 * `COUNT`, `UNTIL`, `BYMONTH`, `BYMONTHDAY` (negative counts from the month's end), `BYDAY` (with an
 * ordinal such as `1MO` or `-1FR` under `MONTHLY`/`YEARLY`), `BYHOUR`, `BYMINUTE`, `BYSECOND`, `WKST`.
 * Anything else (`BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, `SECONDLY`) is refused by name rather than
 * ignored.
 *
 * Without `DTSTART` the rule is anchored at 1970-01-01T00:00 in the zone: give one when the rule
 * uses `INTERVAL` > 1 or `COUNT`, or relies on DTSTART's defaults (a `WEEKLY` rule without `BYDAY`
 * repeats DTSTART's weekday; a missing `BYHOUR`/`BYMINUTE`/`BYSECOND` takes DTSTART's).
 *
 * Local times that don't exist (the hour skipped when clocks go forward) are skipped, as RFC 5545
 * says; an ambiguous one (the hour repeated when they go back) fires once, at its first instant.
 */

type Freq = 'YEARLY' | 'MONTHLY' | 'WEEKLY' | 'DAILY' | 'HOURLY' | 'MINUTELY';

const FREQS: readonly Freq[] = ['YEARLY', 'MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY', 'MINUTELY'];
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const SUPPORTED = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYMONTH',
  'BYMONTHDAY',
  'BYDAY',
  'BYHOUR',
  'BYMINUTE',
  'BYSECOND',
  'WKST',
]);
const DAY_MS = 86_400_000;
/** How far a search walks (days) before concluding a rule never fires again. */
const HORIZON_DAYS = 366 * 30;

interface ByDay {
  weekday: number; // 0 = Sunday
  nth?: number;
}

export interface ParsedRRule {
  freq: Freq;
  interval: number;
  count?: number;
  /** Epoch ms, inclusive. */
  until?: number;
  byMonth?: number[];
  byMonthDay?: number[];
  byDay?: ByDay[];
  byHour?: number[];
  byMinute?: number[];
  bySecond?: number[];
  wkst: number;
  /** Epoch ms of DTSTART. */
  start: number;
  timezone: string;
}

interface Civil {
  y: number;
  m: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** The wall-clock fields of `ms` in `timezone`. */
function civilOf(ms: number, timezone: string): Civil {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return {
    y: parts.year as number,
    m: parts.month as number,
    d: parts.day as number,
    h: (parts.hour as number) % 24,
    mi: parts.minute as number,
    s: parts.second as number,
  };
}

function civilAsUtc(c: Civil): number {
  return Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s);
}

/** The instant a wall-clock time denotes in `timezone`; `null` when it doesn't exist (a DST gap). */
function toInstant(c: Civil, timezone: string): number | null {
  const wall = civilAsUtc(c);
  const candidates = new Set<number>();
  for (const probe of [wall - DAY_MS, wall, wall + DAY_MS]) {
    const offset = civilAsUtc(civilOf(probe, timezone)) - probe;
    candidates.add(wall - offset);
  }
  const exact = [...candidates].filter((t) => civilAsUtc(civilOf(t, timezone)) === wall);
  return exact.length > 0 ? Math.min(...exact) : null;
}

function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDayNumber(n: number): { y: number; m: number; d: number; weekday: number } {
  const date = new Date(n * DAY_MS);
  return {
    y: date.getUTCFullYear(),
    m: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    weekday: date.getUTCDay(),
  };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function list(
  value: string,
  part: string,
  min: number,
  max: number,
  allowNegative = false,
): number[] {
  return value.split(',').map((raw) => {
    const n = Number(raw);
    const ok =
      Number.isInteger(n) && (allowNegative ? n !== 0 && Math.abs(n) <= max : n >= min && n <= max);
    if (!ok) throw new Error(`rrule: invalid ${part} value "${raw}"`);
    return n;
  });
}

function parseDateTime(value: string, timezone: string, part: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!match) throw new Error(`rrule: invalid ${part} "${value}"`);
  const [, y, m, d, h = '0', mi = '0', s = '0', z] = match;
  const civil = { y: Number(y), m: Number(m), d: Number(d), h: +h, mi: +mi, s: +s };
  if (z) return civilAsUtc(civil);
  const instant = toInstant(civil, timezone);
  if (instant === null) throw new Error(`rrule: ${part} "${value}" does not exist in ${timezone}`);
  return instant;
}

/** Parse and validate a rule. Throws with the offending part named. */
export function parseRRule(text: string, timezone = 'UTC'): ParsedRRule {
  formatter(timezone); // an unknown zone throws a RangeError here
  let start = toInstant({ y: 1970, m: 1, d: 1, h: 0, mi: 0, s: 0 }, timezone) ?? 0;
  let ruleText: string | undefined;
  for (const line of text.trim().split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    if (/^DTSTART[:;]/i.test(l)) {
      const value = l.slice(l.lastIndexOf(':') + 1);
      start = parseDateTime(value, timezone, 'DTSTART');
    } else {
      ruleText = l.replace(/^RRULE:/i, '');
    }
  }
  if (!ruleText) throw new Error('rrule: no rule (expected e.g. "FREQ=WEEKLY;BYDAY=MO")');
  const parts = new Map<string, string>();
  for (const pair of ruleText.split(';')) {
    if (!pair) continue;
    const [key, value] = pair.split('=');
    const name = key?.toUpperCase() ?? '';
    if (!value) throw new Error(`rrule: "${pair}" has no value`);
    if (!SUPPORTED.has(name)) throw new Error(`rrule: ${name} is not supported`);
    parts.set(name, value.toUpperCase());
  }
  const freq = parts.get('FREQ') as Freq | undefined;
  if (!freq) throw new Error('rrule: FREQ is required');
  if (!FREQS.includes(freq)) throw new Error(`rrule: FREQ=${freq} is not supported`);
  if (parts.has('COUNT') && parts.has('UNTIL'))
    throw new Error('rrule: COUNT and UNTIL are exclusive');
  const interval = parts.has('INTERVAL')
    ? (list(parts.get('INTERVAL') as string, 'INTERVAL', 1, 10_000)[0] as number)
    : 1;
  const byDay = parts
    .get('BYDAY')
    ?.split(',')
    .map((raw): ByDay => {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(raw);
      if (!match) throw new Error(`rrule: invalid BYDAY value "${raw}"`);
      const weekday = WEEKDAYS.indexOf(match[2] as (typeof WEEKDAYS)[number]);
      if (match[1] === undefined) return { weekday };
      if (freq !== 'MONTHLY' && freq !== 'YEARLY') {
        throw new Error(`rrule: BYDAY with an ordinal ("${raw}") needs FREQ=MONTHLY or YEARLY`);
      }
      const nth = Number(match[1]);
      if (nth === 0 || Math.abs(nth) > 53) throw new Error(`rrule: invalid BYDAY value "${raw}"`);
      return { weekday, nth };
    });
  const wkstText = parts.get('WKST') ?? 'MO';
  const wkst = WEEKDAYS.indexOf(wkstText as (typeof WEEKDAYS)[number]);
  if (wkst < 0) throw new Error(`rrule: invalid WKST "${wkstText}"`);
  const rule: ParsedRRule = {
    freq,
    interval,
    wkst,
    start,
    timezone,
    ...(parts.has('COUNT')
      ? { count: list(parts.get('COUNT') as string, 'COUNT', 1, 1_000_000)[0] as number }
      : {}),
    ...(parts.has('UNTIL')
      ? { until: parseDateTime(parts.get('UNTIL') as string, timezone, 'UNTIL') }
      : {}),
    ...(parts.has('BYMONTH')
      ? { byMonth: list(parts.get('BYMONTH') as string, 'BYMONTH', 1, 12) }
      : {}),
    ...(parts.has('BYMONTHDAY')
      ? { byMonthDay: list(parts.get('BYMONTHDAY') as string, 'BYMONTHDAY', 1, 31, true) }
      : {}),
    ...(byDay ? { byDay } : {}),
    ...(parts.has('BYHOUR')
      ? { byHour: list(parts.get('BYHOUR') as string, 'BYHOUR', 0, 23) }
      : {}),
    ...(parts.has('BYMINUTE')
      ? { byMinute: list(parts.get('BYMINUTE') as string, 'BYMINUTE', 0, 59) }
      : {}),
    ...(parts.has('BYSECOND')
      ? { bySecond: list(parts.get('BYSECOND') as string, 'BYSECOND', 0, 59) }
      : {}),
  };
  return rule;
}

/** Whether the local date `day` belongs to the rule (period, BYMONTH, BYMONTHDAY, BYDAY). */
function dayMatches(rule: ParsedRRule, anchor: Civil, day: number): boolean {
  const { y, m, d, weekday } = fromDayNumber(day);
  const anchorDay = dayNumber(anchor.y, anchor.m, anchor.d);
  if (day < anchorDay) return false;
  // The period an occurrence must fall in: every INTERVAL-th year/month/week/day from DTSTART's.
  if (rule.freq === 'YEARLY' && (y - anchor.y) % rule.interval !== 0) return false;
  if (rule.freq === 'MONTHLY' && (y * 12 + m - (anchor.y * 12 + anchor.m)) % rule.interval !== 0)
    return false;
  if (rule.freq === 'WEEKLY') {
    const weekStart = (n: number) => n - ((fromDayNumber(n).weekday - rule.wkst + 7) % 7);
    if (((weekStart(day) - weekStart(anchorDay)) / 7) % rule.interval !== 0) return false;
  }
  if (rule.freq === 'DAILY' && (day - anchorDay) % rule.interval !== 0) return false;

  const byMonth =
    rule.byMonth ??
    (rule.freq === 'YEARLY' && !rule.byMonthDay && !rule.byDay ? [anchor.m] : undefined);
  if (byMonth && !byMonth.includes(m)) return false;

  const dim = daysInMonth(y, m);
  let byMonthDay = rule.byMonthDay;
  if (!byMonthDay && !rule.byDay && (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY'))
    byMonthDay = [anchor.d];
  if (byMonthDay && !byMonthDay.some((md) => (md > 0 ? md : dim + md + 1) === d)) return false;

  let byDay = rule.byDay;
  if (!byDay && rule.freq === 'WEEKLY') byDay = [{ weekday: fromDayNumber(anchorDay).weekday }];
  if (byDay) {
    const hit = byDay.some((bd) => {
      if (bd.weekday !== weekday) return false;
      if (bd.nth === undefined) return true;
      // Ordinal within the month (MONTHLY, or YEARLY with BYMONTH), else within the year.
      const inMonth = rule.freq === 'MONTHLY' || rule.byMonth !== undefined;
      const firstDay = inMonth ? dayNumber(y, m, 1) : dayNumber(y, 1, 1);
      const lastDay = inMonth ? dayNumber(y, m, dim) : dayNumber(y, 12, 31);
      return bd.nth > 0
        ? Math.floor((day - firstDay) / 7) + 1 === bd.nth
        : Math.floor((lastDay - day) / 7) + 1 === -bd.nth;
    });
    if (!hit) return false;
  }
  return true;
}

/** The rule's occurrences on one local date, as sorted instants. */
function occurrencesOn(rule: ParsedRRule, anchor: Civil, day: number): number[] {
  if (!dayMatches(rule, anchor, day)) return [];
  const { y, m, d } = fromDayNumber(day);
  const anchorDay = dayNumber(anchor.y, anchor.m, anchor.d);
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  let hours =
    rule.byHour ?? (rule.freq === 'HOURLY' || rule.freq === 'MINUTELY' ? range(24) : [anchor.h]);
  if (rule.freq === 'HOURLY') {
    hours = hours.filter((h) => ((day - anchorDay) * 24 + h - anchor.h) % rule.interval === 0);
  }
  const minutes = rule.byMinute ?? (rule.freq === 'MINUTELY' ? range(60) : [anchor.mi]);
  const seconds = rule.bySecond ?? [anchor.s];
  const out: number[] = [];
  for (const h of hours) {
    for (const mi of minutes) {
      if (rule.freq === 'MINUTELY') {
        const sinceAnchor = ((day - anchorDay) * 24 + h - anchor.h) * 60 + mi - anchor.mi;
        if (sinceAnchor % rule.interval !== 0) continue;
      }
      for (const s of seconds) {
        const instant = toInstant({ y, m, d, h, mi, s }, rule.timezone);
        if (
          instant !== null &&
          instant >= rule.start &&
          (rule.until === undefined || instant <= rule.until)
        ) {
          out.push(instant);
        }
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** With COUNT: the first COUNT occurrences, from DTSTART. */
function countedOccurrences(rule: ParsedRRule, anchor: Civil): number[] {
  const out: number[] = [];
  const first = dayNumber(anchor.y, anchor.m, anchor.d);
  for (let day = first; day < first + HORIZON_DAYS && out.length < (rule.count as number); day++) {
    for (const t of occurrencesOn(rule, anchor, day)) {
      if (out.length < (rule.count as number)) out.push(t);
    }
  }
  return out;
}

/** The first occurrence strictly after `afterMs`, or `null` when the rule has ended. */
export function nextRRuleFireMs(rule: ParsedRRule, afterMs: number): number | null {
  const anchor = civilOf(rule.start, rule.timezone);
  if (rule.count !== undefined)
    return countedOccurrences(rule, anchor).find((t) => t > afterMs) ?? null;
  const from = Math.max(afterMs, rule.start - 1);
  const c = civilOf(from, rule.timezone);
  const firstDay = dayNumber(c.y, c.m, c.d);
  for (let day = firstDay; day < firstDay + HORIZON_DAYS; day++) {
    if (rule.until !== undefined && day * DAY_MS > rule.until + DAY_MS) return null;
    const hit = occurrencesOn(rule, anchor, day).find((t) => t > afterMs);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** The latest occurrence at or before `atMs`, or `null` when there is none yet. */
export function prevRRuleFireMs(rule: ParsedRRule, atMs: number): number | null {
  const anchor = civilOf(rule.start, rule.timezone);
  if (rule.count !== undefined) {
    const before = countedOccurrences(rule, anchor).filter((t) => t <= atMs);
    return before.length > 0 ? (before[before.length - 1] as number) : null;
  }
  const c = civilOf(atMs, rule.timezone);
  const lastDay = dayNumber(c.y, c.m, c.d);
  const anchorDay = dayNumber(anchor.y, anchor.m, anchor.d);
  for (let day = lastDay; day >= anchorDay && day > lastDay - HORIZON_DAYS; day--) {
    const hits = occurrencesOn(rule, anchor, day).filter((t) => t <= atMs);
    if (hits.length > 0) return hits[hits.length - 1] as number;
  }
  return null;
}
