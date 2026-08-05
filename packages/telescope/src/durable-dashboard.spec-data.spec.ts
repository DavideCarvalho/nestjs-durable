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

  // A section renders as a fixed `grid-cols-N` grid, one panel per cell, with no `colSpan`. A panel
  // count that is not a multiple of `cols` therefore leaves a visible hole beside the last row —
  // which is how the Workers section shipped: one eleven-column table declared `cols: 2`, so it got
  // half the viewport and scrolled sideways inside its card while the cell next to it sat empty.
  it('fills every grid row — no section leaves a hole beside its last panel', () => {
    const d = durableDashboard({ runHref: '/durable/runs/{runId}' });
    for (const section of d.sections ?? []) {
      const cols = section.cols ?? 1;
      expect(
        section.panels.length % cols,
        `section "${section.title}": ${section.panels.length} panels in a ${cols}-column grid`,
      ).toBe(0);
    }
  });

  it('gives the workers table the full width of its row', () => {
    const d = durableDashboard({ runHref: '/durable/runs/{runId}' });
    const workers = d.sections?.find((s) => s.title === 'Workers');
    expect(workers?.cols).toBe(1);
    expect(workers?.panels).toHaveLength(1);
  });
});
