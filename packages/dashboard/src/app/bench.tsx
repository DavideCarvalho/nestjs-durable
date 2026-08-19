import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import type { GroupHealth, RunStatus, WorkflowRun } from '../client/durable-client';
import { App } from './App';
import '@xyflow/react/dist/style.css';
import './index.css';

/**
 * Scale harness: the REAL `<App/>`, against a control plane as big as a busy one, with a stubbed
 * `fetch`. `preview.html?view=console` answers "does it look right"; this answers "does it stay
 * responsive", which is a different question and needs a different order of magnitude of data.
 *
 * Open `bench.html` and read `window.__bench` (or drive it from CDP). The number that matters is
 * `longTasks`: every entry is a frame the browser could not paint, which is what "the console froze"
 * actually is. `longTaskAt` separates the one-off mount from the steady poll loop.
 *
 * Query params:
 *   `runs`   how many runs the fake control plane holds (default 10000)
 *   `steps`  checkpoints on the run a `#/run/<id>` deep link opens (default 488)
 *   `churn`  how many runs change between polls (default 5) — a static fixture lets React Query's
 *            structural sharing skip the re-render entirely, which flatters the result
 *   `page`   override the SPA's page size assumptions by capping the fake store instead
 */

declare global {
  interface Window {
    __bench: {
      polls: number;
      runs: number;
      /** Every main-thread task over 50ms, in ms. */
      longTasks: number[];
      /** Each long task's start, ms since navigation — separates the mount from the poll loop. */
      longTaskAt: number[];
    };
  }
}

window.__bench = { polls: 0, runs: 0, longTasks: [], longTaskAt: [] };

new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    window.__bench.longTasks.push(Math.round(entry.duration));
    window.__bench.longTaskAt.push(Math.round(entry.startTime));
  }
}).observe({ entryTypes: ['longtask'] });

const params = new URLSearchParams(window.location.search);
const RUNS = Number(params.get('runs') ?? '10000');
const STEPS = Number(params.get('steps') ?? '488');
const CHURN = Number(params.get('churn') ?? '5');

// Proportions and payload sizes taken from a real 9.5k-run control plane: mostly settled runs, a
// large minority failed, and a stack trace on every failure — which is what made the untrimmed
// listing 12 MB. The generator reproduces the SHAPE; no real run data lives in this repo.
const WORKFLOWS = [
  'ingestion',
  'catalog.workflow-run',
  'link-subwo-to-mvr',
  'etl',
  'dpas-extraction',
];
const ORIGINS = ['@dudousxd/nestjs-catalog-pipeline', '@dudousxd/nestjs-agent', undefined];
const STACK = Array.from(
  { length: 12 },
  (_, i) => `    at frame${i} (/app/dist/src/step-${i}.js:${i * 7}:19)`,
).join('\n');
const T0 = Date.parse('2026-08-01T00:00:00.000Z');

function makeRun(i: number): WorkflowRun {
  const failed = i % 5 < 2;
  const status: RunStatus = failed ? 'failed' : i % 97 === 0 ? 'suspended' : 'completed';
  const at = new Date(T0 + i * 60_000).toISOString();
  return {
    id: `${WORKFLOWS[i % WORKFLOWS.length]}:${i}:2026-08-01T00:00`,
    workflow: WORKFLOWS[i % WORKFLOWS.length] as string,
    workflowVersion: '4',
    status,
    namespace: 'default',
    ...(ORIGINS[i % ORIGINS.length] !== undefined
      ? { origin: ORIGINS[i % ORIGINS.length] as string }
      : {}),
    tags: [`tier:${i % 3}`, `region:r${i % 4}`],
    createdAt: at,
    updatedAt: at,
    input: { file: `drop-${i}.csv`, base: `base-${i % 12}` },
    ...(failed ? { error: { message: `step ${i} failed after 3 attempts`, stack: STACK } } : {}),
  } as WorkflowRun;
}

let all: WorkflowRun[] = Array.from({ length: RUNS }, (_, i) => makeRun(i));
window.__bench.runs = all.length;

const workers: GroupHealth[] = WORKFLOWS.map((w) => ({
  group: w,
  kind: 'workflow',
  depth: 0,
  liveWorkers: [{ group: w, instanceId: `worker-${w}`, lastBeatAt: T0 }],
}));

/** Production never serves the same bytes twice — workers land results constantly. */
function churn(): void {
  if (CHURN <= 0) return;
  const now = new Date().toISOString();
  all = all.map((run, i) => (i < CHURN ? { ...run, updatedAt: now } : run));
}

/** A run detail as heavy as the heaviest measured on a live control plane, so the detail pane is
 *  exercised at its real worst case rather than at a typical 25 steps. */
function heavyDetail(id: string): unknown {
  return {
    run: makeRun(0),
    timeline: Array.from({ length: STEPS }, (_, i) => ({
      runId: id,
      seq: i,
      name: `handle_chunk_${i}`,
      kind: i % 3 === 0 ? 'remote' : 'local',
      status: 'completed',
      attempts: 1,
      workerGroup: 'ingestion',
      startedAt: new Date(T0 + i * 900).toISOString(),
      finishedAt: new Date(T0 + i * 900 + 700).toISOString(),
    })),
    children: [],
  };
}

/** The server's own predicates, applied here so the harness measures the SAME work a real control
 *  plane hands the SPA — a page, not the whole listing. */
function serve(route: string, query: URLSearchParams): unknown {
  const detail = route.match(/^\/runs\/(.+)$/);
  if (detail?.[1] && detail[1] !== 'facets') return heavyDetail(decodeURIComponent(detail[1]));
  if (route === '/runs/facets') {
    const cells = new Map<string, { status: string; origin: string | null; count: number }>();
    for (const run of all) {
      const origin = run.origin?.trim() ? run.origin : null;
      const key = `${run.status}|${origin ?? ''}`;
      const cell = cells.get(key);
      if (cell) cell.count += 1;
      else cells.set(key, { status: run.status, origin, count: 1 });
    }
    return [...cells.values()];
  }
  if (route !== '/runs') return undefined;
  window.__bench.polls += 1;
  churn();
  const statuses = query.getAll('status');
  const origin = query.get('origin');
  const limit = query.get('limit');
  let rows = all;
  if (statuses.length) rows = rows.filter((r) => statuses.includes(r.status));
  if (query.get('unattributed') === 'true') rows = rows.filter((r) => !r.origin?.trim());
  else if (origin) rows = rows.filter((r) => r.origin === origin);
  // The list endpoint's projection — the payloads the console never renders in a row.
  const page = limit ? rows.slice(0, Number(limit)) : rows;
  return page.map((r) => {
    const { input: _i, output: _o, error: _e, ...row } = r;
    return row;
  });
}

const real = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const match = url.match(/\/durable\/api(\/[^?]*)\??(.*)$/);
  const route = match?.[1];
  if (!route) return real(input as RequestInfo, init);
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  if (route === '/workers') return json(workers);
  if (route === '/topology') return json({ role: 'control-plane' });
  const payload = serve(route, new URLSearchParams(match?.[2] ?? ''));
  return payload === undefined ? real(input as RequestInfo, init) : json(payload);
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <QueryClientProvider client={new QueryClient()}>
    <App />
  </QueryClientProvider>,
);
