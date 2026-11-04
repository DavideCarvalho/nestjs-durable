// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleDelivery } from '../client/durable-client';
import { deriveRunState } from '../client/durable-client';
import {
  LIFECYCLE_PENDING_TAG,
  LifecycleDeliveries,
  LifecyclePendingFilter,
  LifecycleSourceLine,
  RunWaits,
  deliveryNote,
  formatSpan,
  withTriggerErrors,
} from './RunLifecycle';
import { runWaitTargetOfStep } from './child-link';

// No jest-dom in this package (see `open-console.spec.tsx`): assertions read plain DOM properties.

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;
const settledAt = Date.parse('2026-11-01T00:00:00.000Z');

const deliveries: LifecycleDelivery[] = [
  { subscriber: 'digest', state: 'coalesced', runId: '__evtacc__:digest' },
  { subscriber: 'late', state: 'not-started' },
  {
    subscriber: 'refresh',
    state: 'started',
    runId: 'evt:i1:completed:refresh',
    status: 'running',
  },
  { subscriber: 'removed', state: 'owed', owedSince: settledAt, orphanAt: settledAt + 24 * HOUR },
  { subscriber: 'waiting', state: 'owed', owedSince: settledAt },
];

function rows(): { state: string | null; text: string[] }[] {
  const section = screen.getByRole('region', { name: 'Lifecycle subscribers' });
  return within(section)
    .getAllByRole('listitem')
    .map((li) => ({
      state: li.getAttribute('data-state'),
      text: [...li.querySelectorAll('a, span, button')]
        .filter((el) => el.children.length === 0)
        .map((el) => el.textContent ?? ''),
    }));
}

describe('<LifecycleDeliveries>', () => {
  it('draws one row per subscriber with its state and what it links to', () => {
    const onOpenRun = vi.fn();
    render(
      <LifecycleDeliveries
        deliveries={deliveries}
        now={settledAt + 3 * HOUR}
        onOpenRun={onOpenRun}
      />,
    );

    expect(rows()).toEqual([
      { state: 'coalesced', text: ['digest', 'coalesced', '__evtacc__:digest'] },
      { state: 'not-started', text: ['late', 'not started'] },
      {
        state: 'started',
        text: ['refresh', 'started', 'evt:i1:completed:refresh', 'running'],
      },
      { state: 'owed', text: ['removed', 'owed for 3h · orphan in 21h'] },
      { state: 'owed', text: ['waiting', 'owed for 3h'] },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'evt:i1:completed:refresh' }));
    expect(onOpenRun).toHaveBeenCalledWith('evt:i1:completed:refresh');
    expect(screen.getByRole('link', { name: 'refresh' }).getAttribute('href')).toBe(
      '#/workflow/refresh',
    );
  });

  it('shows a failed subscriber with its error and retries it with Republish', () => {
    const onRepublish = vi.fn();
    render(
      <LifecycleDeliveries
        deliveries={[
          { subscriber: 'broken', state: 'failed' },
          { subscriber: 'strict', state: 'failed', error: 'bad input' },
        ]}
        onOpenRun={() => {}}
        onRepublish={onRepublish}
      />,
    );

    expect(rows()).toEqual([
      { state: 'failed', text: ['broken', 'failed', 'Republish'] },
      { state: 'failed', text: ['strict', 'failed', 'bad input', 'Republish'] },
    ]);
    const broken = screen.getAllByRole('listitem')[0] as HTMLElement;
    expect(within(broken).getByText('failed').getAttribute('title')).toContain(
      'run.trigger_failed event carries the reason',
    );
    fireEvent.click(within(broken).getByRole('button', { name: 'Republish' }));
    expect(onRepublish).toHaveBeenCalledWith('broken');
  });

  it('fills a failed delivery error from the trigger_failed events seen', () => {
    const failed: LifecycleDelivery[] = [
      { subscriber: 'a', state: 'failed' },
      { subscriber: 'b', state: 'failed', error: 'kept' },
      { subscriber: 'c', state: 'not-started' },
    ];
    expect(withTriggerErrors(failed, { a: 'boom', b: 'other', c: 'x' })).toEqual([
      { subscriber: 'a', state: 'failed', error: 'boom' },
      { subscriber: 'b', state: 'failed', error: 'kept' },
      { subscriber: 'c', state: 'not-started' },
    ]);
    expect(withTriggerErrors(failed, {})).toBe(failed);
  });

  it('draws nothing without deliveries', () => {
    const { container } = render(<LifecycleDeliveries deliveries={[]} onOpenRun={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('formats spans and notes', () => {
    expect(deliveryNote({ subscriber: 'x', state: 'owed' }, 0)).toBe('owed');
    expect(formatSpan(45_000)).toBe('45s');
    expect(formatSpan(12 * 60_000)).toBe('12m');
    expect(formatSpan(3 * 24 * HOUR)).toBe('3d');
  });
});

describe('<RunWaits>', () => {
  it('links the run waited for, with its status, and the runs waiting for this one', () => {
    const onOpenRun = vi.fn();
    render(
      <RunWaits
        waitsFor={[{ runId: 'i1', seq: 0, status: 'suspended' }]}
        awaitedBy={[
          { runId: 'w1', seq: 2 },
          { runId: 'w2', seq: 0, status: 'suspended' },
        ]}
        onOpenRun={onOpenRun}
      />,
    );

    expect(screen.getByTestId('waits-for').textContent).toBe('Waiting for runi1suspended');
    expect(screen.getByTestId('awaited-by').textContent).toBe('Awaited byw1w2suspended');
    fireEvent.click(screen.getByRole('button', { name: 'i1' }));
    fireEvent.click(screen.getByRole('button', { name: 'w2' }));
    expect(onOpenRun.mock.calls).toEqual([['i1'], ['w2']]);
  });

  it('draws nothing for a run with no run-wait links', () => {
    const { container } = render(<RunWaits onOpenRun={() => {}} />);
    expect(container.textContent).toBe('');
  });
});

describe('<LifecycleSourceLine>', () => {
  it('shows the source run, how it settled, its status and its copyable trace id', () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onOpenRun = vi.fn();
    render(
      <LifecycleSourceLine
        source={{ runId: 'i1', kind: 'failed', status: 'failed', traceId: 'abc123' }}
        onOpenRun={onOpenRun}
      />,
    );

    expect(screen.getByTestId('lifecycle-source').textContent).toBe(
      'started byi1onfailedfailedtraceabc123copy',
    );
    fireEvent.click(screen.getByRole('button', { name: 'i1' }));
    expect(onOpenRun).toHaveBeenCalledWith('i1');
    fireEvent.click(screen.getByRole('button', { name: 'copy' }));
    expect(writeText).toHaveBeenCalledWith('abc123');
  });

  it('leaves the trace out when the source recorded none', () => {
    render(
      <LifecycleSourceLine source={{ runId: 'i1', kind: 'completed' }} onOpenRun={() => {}} />,
    );
    expect(screen.queryByTitle("The source run's trace id")).toBeNull();
  });
});

describe('<LifecyclePendingFilter>', () => {
  it('toggles the lifecycle pending tag in the tag filter', () => {
    const onChange = vi.fn();
    const { rerender } = render(<LifecyclePendingFilter tags={['a']} onChange={onChange} />);
    const chip = screen.getByRole('button', { name: 'lifecycle pending' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip);
    expect(onChange).toHaveBeenLastCalledWith(['a', LIFECYCLE_PENDING_TAG]);

    rerender(<LifecyclePendingFilter tags={['a', LIFECYCLE_PENDING_TAG]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'lifecycle pending' }));
    expect(onChange).toHaveBeenLastCalledWith(['a']);
  });
});

describe('ctx.waitForRun in the timeline', () => {
  it('reads the run a delivered or timed wait waited on', () => {
    expect(runWaitTargetOfStep({ name: 'signal:runwait:a#b#w1#3', runId: 'w1', seq: 3 })).toBe(
      'a#b',
    );
    expect(runWaitTargetOfStep({ name: 'timeout:run:i1', runId: 'w1', seq: 2 })).toBe('i1');
    expect(runWaitTargetOfStep({ name: 'signal:approve', runId: 'w1', seq: 1 })).toBeUndefined();
  });

  it('names a pending run wait in the run state', () => {
    const at = new Date(settledAt).toISOString();
    const run = {
      id: 'w1',
      workflow: 'watcher',
      workflowVersion: '1',
      status: 'suspended' as const,
      createdAt: at,
      updatedAt: at,
    };
    const timeline = [
      {
        runId: 'w1',
        seq: 0,
        name: 'runwait:i1#w1#0',
        kind: 'signal' as const,
        status: 'pending' as const,
        attempts: 1,
        startedAt: at,
        finishedAt: at,
      },
    ];
    expect(deriveRunState(run, { runs: [], health: [], timeline })).toEqual({
      status: 'awaiting',
      detail: 'run i1',
    });
    expect(
      deriveRunState({ ...run, waiting: { on: 'run', name: 'i1' } }, { runs: [], health: [] }),
    ).toEqual({ status: 'awaiting', detail: 'run i1' });
  });
});
