import { describe, expect, it } from 'vitest';
import { durableDashboard } from './durable-dashboard.spec-data';

describe('durableDashboard', () => {
  it('is sectioned with a health row and a trends section', () => {
    const d = durableDashboard({ runHref: '/durable/runs/{runId}' });
    expect(d.sections?.[0].title).toMatch(/health/i);
    const kinds = d.sections?.flatMap((s) => s.panels.map((p) => p.kind)) ?? [];
    expect(kinds).toContain('distribution');
    expect(kinds).toContain('breakdown');
  });
});
