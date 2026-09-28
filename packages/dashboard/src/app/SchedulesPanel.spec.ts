import { describe, expect, it } from 'vitest';
import { cadenceLabel, relativeTo } from './SchedulesPanel';

describe('SchedulesPanel helpers', () => {
  it('labels cron (with a non-UTC zone) and interval cadences', () => {
    expect(cadenceLabel({ cron: '0 9 * * 1-5', timezone: 'America/Sao_Paulo' })).toBe(
      '0 9 * * 1-5 · America/Sao_Paulo',
    );
    expect(cadenceLabel({ cron: '*/5 * * * *', timezone: 'UTC' })).toBe('*/5 * * * *');
    expect(cadenceLabel({ everyMs: 900_000 })).toBe('every 15m');
    expect(cadenceLabel({ everyMs: 7_200_000 })).toBe('every 2h');
    expect(cadenceLabel({ everyMs: 1_500 })).toBe('every 1500ms');
  });

  it('renders an instant relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(relativeTo('2026-01-01T00:04:00Z', now)).toBe('in 4m');
    expect(relativeTo('2025-12-31T21:00:00Z', now)).toBe('3h ago');
    expect(relativeTo('2026-01-03T00:00:00Z', now)).toBe('in 2d');
  });
});
