import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StepCheckpoint, WorkflowRun } from '../client/durable-client';
import { RunSpans } from './SpansTimeline';

// A structural (not pixel) render test for the StepRow / ParallelFan split: render RunSpans to a
// static HTML string and assert on counts, the fan label, and single-vs-fan grouping. No jsdom/RTL
// (the repo has neither) — react-dom/server is already a dashboard dep for SSR, so this is infra-free.

const RUN: WorkflowRun = {
  id: 'r1',
  workflow: 'demo',
  workflowVersion: '1',
  status: 'completed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:05.000Z',
};

function cp(over: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'r1',
    seq: 0,
    name: 'step',
    kind: 'local',
    status: 'completed',
    attempts: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    ...over,
  };
}

/** Render RunSpans for a timeline to a static HTML string (wrapped in a QueryClientProvider, which
 *  `useChildRuns` needs). */
function renderSpans(timeline: StepCheckpoint[]): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(RunSpans, {
        run: RUN,
        timeline,
        depth: 0,
        onSelect: () => {},
        onOpenRun: () => {},
        expanded: new Set<string>(),
        onToggleChild: () => {},
      }),
    ),
  );
}

/** The fan group header carries this exact title attribute — count it to count fan groups. */
const FAN_HEADER = 'parallel fan-out (ctx.gather / ctx.all)';
/** Every StepRow's top-level clickable row carries the grid template column for its name+bar. */
const STEP_ROW = 'grid-cols-[150px_1fr]';

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('RunSpans render structure', () => {
  it('renders a [setup, fan×3, finalize] timeline as 1 fan group + N+2 step rows', () => {
    const timeline = [
      cp({ seq: 0, name: 'setup' }),
      ...Array.from({ length: 3 }, (_, k) =>
        cp({ seq: k + 1, name: `handle_${k}`, parallelGroup: 'gather:1' }),
      ),
      cp({ seq: 4, name: 'finalize' }),
    ];
    const html = renderSpans(timeline);

    // Exactly ONE fan group, labelled from the shared name prefix (`handle ×3`).
    expect(count(html, FAN_HEADER)).toBe(1);
    expect(html).toContain('handle ×3');

    // Total step rows = the 3 fan members + the 2 sequential singles = 5.
    expect(count(html, STEP_ROW)).toBe(5);

    // The fan members are present by name; the two sequential steps render as ordinary rows.
    for (const name of ['handle_0', 'handle_1', 'handle_2', 'setup', 'finalize']) {
      expect(html).toContain(name);
    }
  });

  it('renders an all-single timeline (no parallelGroup) with no fan group', () => {
    const timeline = [
      cp({ seq: 0, name: 'a' }),
      cp({ seq: 1, name: 'b' }),
      cp({ seq: 2, name: 'c' }),
    ];
    const html = renderSpans(timeline);

    // No parallelGroup anywhere → no fan group, every step is a single row.
    expect(count(html, FAN_HEADER)).toBe(0);
    expect(count(html, STEP_ROW)).toBe(3);
    for (const name of ['a', 'b', 'c']) expect(html).toContain(name);
  });
});
