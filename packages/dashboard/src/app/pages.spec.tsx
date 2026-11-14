// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupHealth, ScheduleSummary } from '../client/durable-client';
import { SchedulesView } from './SchedulesPanel';
import { WorkersView } from './workers/WorkersPage';

afterEach(cleanup);

describe('WorkersView', () => {
  it('shows skeletons while loading, then metrics, pods and the starved queues', () => {
    const { rerender } = render(
      <WorkersView groups={undefined} groupsError={null} onRetryGroups={() => {}} />,
    );
    expect(document.querySelector('[data-slot=skeleton]')).toBeTruthy();
    const groups = [
      {
        group: 'wf:checkout',
        depth: 3,
        liveWorkers: [{ group: 'wf:checkout', instanceId: 'pod-a', lastBeatAt: Date.now() }],
      },
      { group: 'step:charge', depth: 2, liveWorkers: [] },
    ] as unknown as GroupHealth[];
    rerender(<WorkersView groups={groups} groupsError={null} onRetryGroups={() => {}} />);
    expect(screen.getByText('Live workers')).toBeTruthy();
    expect(screen.getAllByText('pod-a').length).toBeGreaterThan(0);
    expect(screen.getByText('step:charge')).toBeTruthy();
  });

  it('shows a region error with a retry when the workers fail to load', () => {
    const retry = vi.fn();
    render(
      <WorkersView groups={undefined} groupsError={new Error('boom')} onRetryGroups={retry} />,
    );
    expect(screen.getByText('Workers could not be loaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalled();
  });
});

describe('SchedulesView', () => {
  const schedule = {
    id: 'nightly',
    workflow: 'reconcile',
    namespace: 'default',
    cron: '0 3 * * *',
    timezone: 'UTC',
    paused: false,
    nextFireAt: new Date(Date.now() + 60_000).toISOString(),
  } as unknown as ScheduleSummary;

  it('lists schedules and runs the pause / run-now actions', () => {
    const onAction = vi.fn();
    render(
      <SchedulesView
        schedules={[schedule]}
        error={null}
        onRetry={() => {}}
        busy={false}
        onAction={onAction}
      />,
    );
    expect(screen.getByText('nightly')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'pause' }));
    fireEvent.click(screen.getByRole('button', { name: 'run now' }));
    expect(onAction.mock.calls).toEqual([
      ['nightly', 'pause'],
      ['nightly', 'trigger'],
    ]);
  });

  it('shows the empty state when there are none', () => {
    render(
      <SchedulesView
        schedules={[]}
        error={null}
        onRetry={() => {}}
        busy={false}
        onAction={() => {}}
      />,
    );
    expect(screen.getByText('No schedules')).toBeTruthy();
  });
});
