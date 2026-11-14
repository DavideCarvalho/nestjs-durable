import type {
  DurableTopology,
  GroupHealth,
  RunDetail,
  ScheduleSummary,
  StepCheckpoint,
  WorkflowRun,
} from '../client/durable-client';

/**
 * A hand-built snapshot of a live control plane, served to the SPA by stubbing `fetch`. Used only by
 * `preview.html?view=console` — the standalone visual-verification entry — so the WHOLE console
 * (header, filter chips, workers panel, run list, run detail, spans) can be screenshotted with its
 * real components and real styling, with no server, no database and no workers.
 *
 * It is deliberately a *representative* snapshot rather than a minimal one: several `completed`
 * (green) runs sit next to the green interactive affordances (accent logo, `retry all`, `Retry`) so a
 * screenshot can settle the accent-vs-status question in AVIARY-UI.md with evidence.
 *
 * It is also deliberately MIXED on the two provenance axes, because a snapshot where every run is
 * attributed would hide the case that matters: two runs (`inv-2b91ee70`, `bck-4410aa03`) carry no
 * `origin` at all — the `app` bucket (the app's own workflows) a real deployment is mostly made
 * of — and two sit in a named tenant rather than `default`.
 */

const T0 = Date.parse('2026-07-29T09:14:00.000Z');
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

const runs: WorkflowRun[] = [
  {
    id: 'ord-9f2c1a4b',
    workflow: 'checkout',
    workflowVersion: '4',
    status: 'failed',
    namespace: 'default',
    origin: 'acme-storefront',
    createdAt: iso(-620_000),
    updatedAt: iso(-540_000),
    tags: ['tier:pro', 'region:us-east'],
    searchAttributes: { amount: 249, tier: 'pro' },
    input: { orderId: 'ord-9f2c1a4b', amount: 249, currency: 'USD' },
    error: { message: 'charge declined: card_expired (stripe: card_error)' },
  },
  {
    id: 'ord-77ab3012',
    workflow: 'checkout',
    workflowVersion: '4',
    status: 'completed',
    origin: 'acme-storefront',
    createdAt: iso(-1_800_000),
    updatedAt: iso(-1_744_000),
    tags: ['tier:free'],
    input: { orderId: 'ord-77ab3012', amount: 19 },
    output: { charged: true },
  },
  {
    id: 'inv-2b91ee70',
    workflow: 'invoiceSettlement',
    workflowVersion: '2',
    status: 'completed',
    createdAt: iso(-2_100_000),
    updatedAt: iso(-2_010_000),
    input: { invoice: 'INV-4471' },
  },
  {
    id: 'shp-01d4f7c9',
    workflow: 'shipmentSync',
    workflowVersion: '1',
    status: 'running',
    origin: '@dudousxd/nestjs-catalog-pipeline',
    createdAt: iso(-90_000),
    updatedAt: iso(-4_000),
    input: { carrier: 'dhl' },
  },
  {
    id: 'shp-55c2aa18',
    workflow: 'shipmentSync',
    workflowVersion: '1',
    status: 'completed',
    origin: '@dudousxd/nestjs-catalog-pipeline',
    createdAt: iso(-3_400_000),
    updatedAt: iso(-3_330_000),
    input: { carrier: 'ups' },
  },
  {
    id: 'rep-8812cd44',
    workflow: 'nightlyReport',
    workflowVersion: '7',
    status: 'suspended',
    namespace: 'acme',
    origin: '@dudousxd/nestjs-agent',
    createdAt: iso(-5_400_000),
    updatedAt: iso(-300_000),
    waiting: { on: 'signal', name: 'approve' },
    input: { day: '2026-07-28' },
  },
  {
    id: 'ord-1177fe22',
    workflow: 'checkout',
    workflowVersion: '4',
    status: 'completed',
    namespace: 'acme',
    origin: 'acme-storefront',
    createdAt: iso(-7_200_000),
    updatedAt: iso(-7_120_000),
    tags: ['tier:pro'],
    input: { orderId: 'ord-1177fe22', amount: 640 },
    output: { charged: true },
  },
  {
    id: 'bck-4410aa03',
    workflow: 'backfillLedger',
    workflowVersion: '1',
    status: 'cancelled',
    createdAt: iso(-9_000_000),
    updatedAt: iso(-8_880_000),
    input: { from: '2026-01-01' },
  },
  {
    id: 'ord-6650bb91',
    workflow: 'checkout',
    workflowVersion: '4',
    status: 'pending',
    origin: 'acme-storefront',
    createdAt: iso(-12_000),
    updatedAt: iso(-12_000),
    input: { orderId: 'ord-6650bb91', amount: 78 },
  },
];

const failedTimeline: StepCheckpoint[] = [
  {
    runId: 'ord-9f2c1a4b',
    seq: 1,
    name: 'reserveInventory',
    kind: 'remote',
    status: 'completed',
    attempts: 1,
    workerGroup: 'inventory',
    enqueuedAt: iso(-619_000),
    startedAt: iso(-618_200),
    finishedAt: iso(-615_900),
    input: { sku: 'SKU-8823', qty: 1 },
    output: { reservationId: 'rsv-77120' },
  },
  {
    runId: 'ord-9f2c1a4b',
    seq: 2,
    name: 'quoteShipping',
    kind: 'remote',
    status: 'completed',
    attempts: 1,
    workerGroup: 'shipping',
    enqueuedAt: iso(-615_800),
    startedAt: iso(-615_100),
    finishedAt: iso(-612_400),
    output: { carrier: 'dhl', cents: 890 },
  },
  {
    runId: 'ord-9f2c1a4b',
    seq: 3,
    name: 'chargeCard',
    kind: 'remote',
    status: 'failed',
    attempts: 3,
    workerGroup: 'payments',
    enqueuedAt: iso(-612_300),
    startedAt: iso(-611_800),
    finishedAt: iso(-540_000),
    input: { amount: 249, currency: 'USD' },
    error: { message: 'charge declined: card_expired (stripe: card_error)' },
    events: [
      { at: T0 - 611_700, level: 'info', message: 'attempt 1 → gateway timeout, retrying' },
      { at: T0 - 590_000, level: 'warn', message: 'attempt 2 → gateway timeout, retrying' },
      { at: T0 - 540_200, level: 'error', message: 'attempt 3 → card_expired, giving up' },
    ],
  },
];

/** An in-flight run: one settled step and one remote step a worker is running right now — the only
 *  shape that shows the graph's `--live` in-flight styling. */
const runningTimeline: StepCheckpoint[] = [
  {
    runId: 'shp-01d4f7c9',
    seq: 1,
    name: 'fetchManifest',
    kind: 'remote',
    status: 'completed',
    attempts: 1,
    workerGroup: 'shipping',
    enqueuedAt: iso(-89_000),
    startedAt: iso(-88_400),
    finishedAt: iso(-84_100),
    output: { parcels: 42 },
  },
  {
    runId: 'shp-01d4f7c9',
    seq: 2,
    name: 'syncCarrier',
    kind: 'remote',
    status: 'pending',
    attempts: 1,
    workerGroup: 'shipping',
    enqueuedAt: iso(-84_000),
    startedAt: iso(-83_600),
    finishedAt: iso(-4_000),
    input: { carrier: 'dhl', parcels: 42 },
  },
];

const detail: Record<string, RunDetail> = {
  'shp-01d4f7c9': { run: runs[3] as WorkflowRun, timeline: runningTimeline, children: [] },
  'ord-9f2c1a4b': {
    run: runs[0] as WorkflowRun,
    timeline: failedTimeline,
    children: [],
  },
};

const workers: GroupHealth[] = [
  {
    group: 'checkout',
    kind: 'workflow',
    depth: 0,
    liveWorkers: [
      {
        group: 'checkout',
        instanceId: 'api-7f9c4d-2',
        lastBeatAt: T0 - 2_000,
        status: {
          runtime: 'node',
          concurrency: { mode: 'adaptive', limit: 16, min: 4, max: 32 },
          inFlight: 3,
          rssPct: 41,
          cpuPct: 22,
          throughputPerMin: 118,
          p95Ms: 740,
          lastAdjust: { at: T0 - 61_000, from: 12, to: 16, reason: 'grow' },
        },
      },
    ],
  },
  {
    group: 'payments',
    kind: 'step',
    depth: 2,
    liveWorkers: [
      {
        group: 'payments',
        instanceId: 'worker-payments-5b81',
        lastBeatAt: T0 - 3_500,
        status: {
          runtime: 'node',
          concurrency: { mode: 'fixed', limit: 8 },
          inFlight: 7,
          rssPct: 88,
          cpuPct: 63,
          throughputPerMin: 44,
          p95Ms: 2_310,
        },
      },
    ],
  },
  {
    group: 'inventory',
    kind: 'step',
    depth: 0,
    liveWorkers: [
      {
        group: 'inventory',
        instanceId: 'worker-inventory-11ce',
        lastBeatAt: T0 - 1_200,
        status: {
          runtime: 'python',
          concurrency: { mode: 'fixed', limit: 4 },
          inFlight: 1,
        },
      },
    ],
  },
  { group: 'shipping', kind: 'step', depth: 6, liveWorkers: [] },
];

const topology: DurableTopology = { role: 'control-plane' };

/** One decoded `filter[...]` predicate from the console's query string. */
interface MockClause {
  field: string;
  operator: string;
  value: string[];
}

/** Decode the filter the console sends (`filter[tag][]=etl&filter[attr.tier][in]=pro,ent&…`). */
function clauses(search: string | undefined): MockClause[] {
  const byKey = new Map<string, MockClause>();
  for (const [key, value] of new URLSearchParams(search ?? '')) {
    const match = /^filter\[([^[\]]+)\](?:\[([^[\]]+)\])?(\[\])?$/.exec(key);
    if (!match) continue;
    const [, rawField, op, list] = match as unknown as [string, string, string?, string?];
    if (rawField === 'unattributed') {
      if (value === 'true')
        byKey.set('origin:isNull', { field: 'origin', operator: 'isNull', value: [] });
      continue;
    }
    const operator = op ?? (list || value.includes(',') ? 'in' : 'eq');
    const id = `${rawField}:${operator}`;
    const clause = byKey.get(id) ?? { field: rawField, operator, value: [] };
    clause.value.push(...(list ? [value] : value.split(',')));
    byKey.set(id, clause);
  }
  return [...byKey.values()];
}

/** The values one run has on a filter axis — several for `tag`, one (or none) for the columns. */
function valuesOn(run: WorkflowRun, field: string): (string | null)[] {
  if (field === 'tag') return run.tags ?? [];
  if (field === 'namespace') return [run.namespace ?? 'default'];
  if (field === 'origin') return [run.origin ?? null];
  if (field === 'status') return [run.status];
  if (field === 'workflow') return [run.workflow];
  if (field === 'attr') return Object.keys(run.searchAttributes ?? {});
  if (field.startsWith('attr.')) {
    const value = run.searchAttributes?.[field.slice(5)];
    return value === undefined ? [] : [String(value)];
  }
  return [];
}

/**
 * Apply the console's predicates the way a real store does — ANDed, `in` matching ANY, `isNull`
 * selecting the unattributed bucket, absent meaning "don't narrow". Without this the filters in the
 * preview would look broken, and a screenshot of them would be a lie.
 */
function matching(search: string | undefined): WorkflowRun[] {
  const all = clauses(search);
  // `filter[origin]` and `filter[unattributed]` together are a UNION, like the server's.
  const unattributed = all.some((c) => c.operator === 'isNull');
  const named = all.find((c) => c.field === 'origin' && c.operator !== 'isNull');
  return runs.filter((run) => {
    if (unattributed || named) {
      const origin = run.origin ?? null;
      const ok =
        (unattributed && origin === null) || (named?.value.includes(origin ?? '') ?? false);
      if (!ok) return false;
    }
    return all
      .filter((clause) => clause.field !== 'origin')
      .every((clause) => {
        const held = valuesOn(run, clause.field);
        return held.some((value) => value !== null && clause.value.includes(value));
      });
  });
}

/** An offset page of `rows`, the way the server answers `GET runs` and the fan pages. */
function offsetPage<T>(rows: T[], search: string | undefined, defaultSize: number) {
  const params = new URLSearchParams(search ?? '');
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);
  const size = Math.max(1, Number(params.get('size') ?? defaultSize) || defaultSize);
  return {
    data: rows.slice((page - 1) * size, page * size),
    meta: {
      total: rows.length,
      perPage: size,
      currentPage: page,
      lastPage: Math.max(1, Math.ceil(rows.length / size)),
      firstPage: 1,
    },
  };
}

const schedules: ScheduleSummary[] = [
  {
    id: 'nightly-reconcile',
    workflow: 'reconcile-ledger',
    namespace: 'default',
    cron: '0 3 * * *',
    timezone: 'America/Sao_Paulo',
    input: {},
    createdAt: iso(-30 * 86_400_000),
    updatedAt: iso(-86_400_000),
    fires: 42,
    overlap: 'skip',
    catchup: 'latest',
    paused: false,
    nextFireAt: iso(6 * 3_600_000),
    lastFireAt: iso(-18 * 3_600_000),
  },
  {
    id: 'invoice-sweep',
    workflow: 'invoice',
    namespace: 'billing',
    everyMs: 900_000,
    input: {},
    createdAt: iso(-30 * 86_400_000),
    updatedAt: iso(-86_400_000),
    fires: 42,
    overlap: 'skip',
    catchup: 'latest',
    paused: false,
    nextFireAt: iso(240_000),
    lastFireAt: iso(-660_000),
    lastError: 'TimeoutError: ledger lock held for 30s',
  },
  {
    id: 'backup-snapshots',
    workflow: 'backup',
    namespace: 'default',
    cron: '*/30 * * * *',
    timezone: 'UTC',
    input: {},
    createdAt: iso(-30 * 86_400_000),
    updatedAt: iso(-86_400_000),
    fires: 42,
    overlap: 'skip',
    catchup: 'latest',
    paused: true,
    nextFireAt: null,
    lastFireAt: iso(-2 * 86_400_000),
  },
];

/** The other Aviary consoles, as `GET <api>/consoles` lists them. */
const consoles = {
  version: 1,
  current: 'durable',
  consoles: [
    { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
    { id: 'agent', title: 'Agents', icon: 'agent', href: '/agent' },
    { id: 'media', title: 'Media', icon: 'media', href: '/media' },
  ],
};

/** Per-console ⌘K answers, each after its own delay, so the streaming groups can be seen. */
const SEARCH_DELAY_MS: Record<string, number> = {
  durable: 150,
  telescope: 700,
  agent: 1400,
  media: 2400,
};

function searchBody(search: string | undefined): unknown {
  const params = new URLSearchParams(search ?? '');
  const q = (params.get('q') ?? '').toLowerCase();
  const only = params.get('console');
  const groups = [
    {
      id: 'durable',
      title: 'Workflows',
      icon: 'workflow',
      hits: runs
        .filter((r) => r.id.includes(q) || r.workflow.includes(q))
        .slice(0, 5)
        .map((r) => ({
          title: r.id,
          subtitle: `run · ${r.workflow} · ${r.status}`,
          href: `/durable#/run/${r.id}`,
        })),
    },
    {
      id: 'telescope',
      title: 'Telescope',
      icon: 'telescope',
      hits: [
        { title: `GET /orders?q=${q}`, subtitle: 'request · 200 · 41ms', href: '/telescope#/r/1' },
        { title: `${q} timeout`, subtitle: 'exception · 3 occurrences', href: '/telescope#/e/2' },
      ],
    },
    {
      id: 'agent',
      title: 'Agents',
      icon: 'agent',
      hits: [{ title: `thread about ${q}`, subtitle: 'thread · support-bot', href: '/agent#/t/9' }],
    },
    { id: 'media', title: 'Media', icon: 'media', hits: [] },
  ];
  return { version: 1, q, partial: false, results: groups.filter((g) => !only || g.id === only) };
}

function body(path: string): unknown | undefined {
  const [route, search] = path.split('?');
  if (route === '/runs') return offsetPage(matching(search), search, 100);
  if (route === '/runs/facets') {
    const cells = new Map<string, { status: string; origin: string | null; count: number }>();
    for (const run of matching(search)) {
      const origin = run.origin ?? null;
      const key = `${run.status}|${origin}`;
      const cell = cells.get(key) ?? { status: run.status, origin, count: 0 };
      cell.count += 1;
      cells.set(key, cell);
    }
    return { data: [...cells.values()] };
  }
  if (route === '/runs/values') {
    const params = new URLSearchParams(search ?? '');
    const field = params.get('groupByCount[field]') ?? '';
    const limit = Number(params.get('groupByCount[limit]') ?? 100);
    const counts = new Map<string | null, number>();
    for (const run of matching(search)) {
      for (const value of valuesOn(run, field)) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
      .slice(0, limit);
  }
  if (route === '/workers') return workers;
  if (route === '/schedules') return { data: schedules };
  if (route === '/consoles') return consoles;
  if (route === '/consoles/search') return searchBody(search);
  if (route === '/topology') return topology;
  const run = route?.match(/^\/runs\/(.+)$/)?.[1];
  if (run) {
    const id = decodeURIComponent(run);
    return (
      detail[id] ?? {
        run: runs.find((r) => r.id === id),
        timeline: [],
        children: [],
      }
    );
  }
  return undefined;
}

/**
 * Point the SPA's `fetch` at the snapshot above. Anything outside the durable API (fonts, assets) is
 * handed back to the real `fetch`, so the page still loads normally.
 */
export function installMockConsoleApi(): void {
  // The shell fields the server would put in the page's data block.
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = 'durable-dashboard-config';
  block.textContent = JSON.stringify({
    apiBase: '/durable/api',
    switcher: { endpoint: '/durable/api/consoles', others: 3 },
    search: { endpoint: '/durable/api/consoles/search', self: 'durable' },
    viewer: { label: 'Ann Lee', email: 'ann@acme.test', role: 'admin' },
    signOut: { action: '/logout', csrfToken: 'preview' },
  });
  document.head.appendChild(block);
  const real = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = url.match(/\/durable\/api(\/.*)$/);
    const payload = match?.[1] ? body(match[1]) : undefined;
    if (payload === undefined) return real(input as RequestInfo, init);
    const only = match?.[1]?.startsWith('/consoles/search')
      ? new URLSearchParams(match[1].split('?')[1] ?? '').get('console')
      : null;
    if (only) await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS[only] ?? 300));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
