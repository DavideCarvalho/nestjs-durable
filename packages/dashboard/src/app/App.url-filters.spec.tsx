// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OffsetPage, RunDetail, WorkflowRun } from '../client/durable-client';
import { parseRoute, pushRoute } from './routes';

// No jest-dom in this package — plain DOM assertions only.

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const runs =
  vi.fn<
    (
      status?: string,
      tag?: string | string[],
      attr?: string[],
      opts?: { namespace?: string | string[]; origin?: string | null },
    ) => Promise<OffsetPage<WorkflowRun>>
  >();
const getRun = vi.fn<(id: string) => Promise<RunDetail>>();

vi.mock('../client/durable-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/durable-client')>();
  return {
    ...actual,
    durableClient: {
      ...actual.durableClient,
      runs: (...args: Parameters<typeof runs>) => runs(...args),
      run: (id: string) => getRun(id),
      facets: vi.fn().mockResolvedValue([]),
      values: vi.fn().mockResolvedValue([]),
      workers: vi.fn().mockResolvedValue([]),
      schedules: vi.fn().mockResolvedValue([]),
      topology: vi.fn().mockResolvedValue({ role: 'standalone' }),
      streamRun: vi.fn(() => () => {}),
    },
  };
});

// Imported AFTER the mock so `App` picks up the mocked `durableClient`.
const { App } = await import('./App');
const { originParam } = await import('./runs/RunsPage');

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const EMPTY: OffsetPage<WorkflowRun> = {
  data: [],
  meta: { total: 0, perPage: 100, currentPage: 1, lastPage: 1, firstPage: 1 },
};

function detail(id: string): RunDetail {
  return {
    run: {
      id,
      workflow: 'shared-flow',
      workflowVersion: '1',
      status: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    } as WorkflowRun,
    timeline: [],
    children: [],
  };
}

/** Point the test environment at `url` without a navigation. */
function goTo(url: string) {
  window.history.replaceState(null, '', url);
}

function chip(status: string): HTMLElement {
  const bar = screen.getByRole('toolbar', { name: 'filter runs by status' });
  const button = [...bar.querySelectorAll('button')].find(
    (b) => b.querySelector('.uppercase')?.textContent === status,
  );
  if (!button) throw new Error(`no ${status} chip`);
  return button;
}

/** The status / tag / origin the board last asked the server for. */
function lastRunsQuery() {
  const call = runs.mock.calls.at(-1);
  return { status: call?.[0], tag: call?.[1], origin: call?.[3]?.origin };
}

describe('App: the runs board filters live in the URL', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', NoopResizeObserver);
    runs.mockReset();
    runs.mockResolvedValue(EMPTY);
    getRun.mockReset();
    getRun.mockImplementation((id) => Promise.resolve(detail(id)));
  });
  afterEach(async () => {
    cleanup();
    // nuqs flushes URL writes on a short throttle; let a queued one land before the next test.
    await new Promise((resolve) => setTimeout(resolve, 80));
    vi.unstubAllGlobals();
  });

  it('opens filtered from a shared link', async () => {
    goTo('/durable#?status=failed&tag=vip,beta&origin=(app)');
    render(<App />, { wrapper });
    await waitFor(() =>
      expect(lastRunsQuery()).toEqual({ status: 'failed', tag: ['vip', 'beta'], origin: null }),
    );
    expect(chip('failed').getAttribute('aria-pressed')).toBe('true');
  });

  it('a status pick writes the URL (keeping the page path), the default leaves it, Back undoes it', async () => {
    goTo('/durable?tenant=acme');
    render(<App />, { wrapper });
    await waitFor(() => expect(runs).toHaveBeenCalled());
    const start = window.history.length;

    fireEvent.click(chip('failed'));
    await waitFor(() => expect(window.location.hash).toBe('#?status=failed'));
    expect(window.location.pathname).toBe('/durable');
    expect(window.location.search).toBe('?tenant=acme');
    expect(window.history.length).toBe(start + 1);
    await waitFor(() => expect(lastRunsQuery().status).toBe('failed'));

    // Back to "all": the default leaves the URL.
    fireEvent.click(chip('all'));
    await waitFor(() => expect(window.location.hash).toBe(''));
    await waitFor(() => expect(lastRunsQuery().status).toBeUndefined());

    act(() => window.history.back());
    await waitFor(() => expect(chip('failed').getAttribute('aria-pressed')).toBe('true'));
  });

  it('an old `#/run/<id>` link still opens the run; a filtered one keeps its filter', async () => {
    goTo('/durable#/run/r1?status=failed');
    render(<App />, { wrapper });
    await waitFor(() => expect(getRun).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(lastRunsQuery().status).toBe('failed'));
    expect(chip('failed').getAttribute('aria-pressed')).toBe('true');

    // Opening another run carries the filters along.
    act(() => pushRoute({ page: 'runs', runId: 'r2' }, 'status=failed'));
    await waitFor(() => expect(getRun).toHaveBeenCalledWith('r2'));
    expect(window.location.hash).toBe('#/run/r2?status=failed');

    expect(parseRoute('#/run/r1')).toEqual({ page: 'runs', runId: 'r1' });
    expect(parseRoute('#/run/r1?status=failed')).toEqual({ page: 'runs', runId: 'r1' });
    expect(parseRoute('#/workers?x=1')).toEqual({ page: 'workers' });
    expect(parseRoute('#?status=failed')).toEqual({ page: 'runs' });
  });

  it('leaving for Workers and coming back keeps the filters', async () => {
    goTo('/durable#?status=failed');
    render(<App />, { wrapper });
    await waitFor(() => expect(lastRunsQuery().status).toBe('failed'));

    fireEvent.click(screen.getAllByText('Workers')[0] as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe('#/workers'));
    fireEvent.click(screen.getAllByText('Runs')[0] as HTMLElement);
    await waitFor(() => expect(window.location.hash).toBe('#?status=failed'));
    expect(chip('failed').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('originParam', () => {
  it('spells the app facet `(app)` and a package as itself', () => {
    expect(originParam.serialize({ kind: 'unknown' })).toBe('(app)');
    expect(originParam.parse('(app)')).toEqual({ kind: 'unknown' });
    expect(originParam.serialize({ kind: 'origin', origin: '@acme/billing' })).toBe(
      '@acme/billing',
    );
    expect(originParam.parse('@acme/billing')).toEqual({ kind: 'origin', origin: '@acme/billing' });
  });
});
