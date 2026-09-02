import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { durableClient } from './durable-client.js';

/**
 * The filter clauses a request carries, read back out of its query string.
 *
 * The console sends its predicates in `@dudousxd/nestjs-filter`'s structured spelling
 * (`filter[where][0][field]=…`), so a test that asserted on flat params would be asserting the
 * encoding rather than the predicate. This decodes back to what was MEANT.
 */
function clauses(
  url: string | undefined,
): Array<{ field: string; operator: string; value: unknown }> {
  const params = new URLSearchParams(url?.split('?')[1] ?? '');
  const byIndex = new Map<string, { field: string; operator: string; value: unknown }>();
  for (const [key, value] of params) {
    const match = /^filter\[where\]\[(\d+)\]\[(field|operator|value)\](?:\[(\d+)\])?$/.exec(key);
    if (!match) continue;
    const [, index, part, member] = match;
    const clause = byIndex.get(index as string) ?? { field: '', operator: '', value: undefined };
    if (part === 'value' && member !== undefined) {
      const list = (clause.value as unknown[] | undefined) ?? [];
      list[Number(member)] = coerce(value);
      clause.value = list;
    } else if (part === 'value') {
      clause.value = coerce(value);
    } else {
      clause[part as 'field' | 'operator'] = value;
    }
    byIndex.set(index as string, clause);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, clause]) => clause);
}

/** Query strings are text; the server coerces operands the same way. */
function coerce(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** A fake `Window`, just enough of the surface `durable-client.ts` touches. */
interface FakeWindow {
  __DURABLE_BASE__?: string;
  __DURABLE_API__?: string;
  location: { href: string; pathname: string; search: string };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// `vitest.config.ts` runs this suite under `environment: 'node'` (no DOM), so `window` doesn't
// exist by default — `durable-client.ts` already guards every access with `typeof window !==
// 'undefined'`. Stub a minimal one here to exercise the browser-navigation branch.
describe('durableClient: the run-list query string', () => {
  /** Capture the URL the client fetches, answering with an empty run list. */
  function captureUrl(): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(jsonResponse([], 200));
      }),
    );
    return { calls };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('sends NO namespace param by default — every tenant, as the console has always shown', async () => {
    // Core: read paths are deliberately not namespace-scoped. Defaulting to the host's own tenant
    // here would silently hide other tenants' runs from every existing operator.
    const { calls } = captureUrl();
    await durableClient.runs();
    expect(calls[0]).toBe('/durable/api/runs');
  });

  it('drops an empty namespace/origin rather than filtering on the empty string', async () => {
    // A cleared filter box is "all", not an exact match against a tenant nobody has.
    const { calls } = captureUrl();
    await durableClient.runs(undefined, undefined, undefined, { namespace: '', origin: '' });
    expect(calls[0]).toBe('/durable/api/runs');
  });

  it('sends the namespace and origin the operator chose', async () => {
    const { calls } = captureUrl();
    await durableClient.runs(undefined, 'tier:pro', undefined, {
      namespace: 'acme',
      origin: '@dudousxd/nestjs-catalog-pipeline',
    });
    expect(clauses(calls[0])).toEqual([
      { field: 'tag', operator: 'equals', value: 'tier:pro' },
      { field: 'namespace', operator: 'equals', value: 'acme' },
      { field: 'origin', operator: 'equals', value: '@dudousxd/nestjs-catalog-pipeline' },
    ]);
  });

  it('matches ANY of several values on one axis, which is what a multi-select produces', async () => {
    // Two `equals` clauses on one field would be ANDed, and no run has one tag with two values —
    // the selection has to travel as a SET or the second pick empties the list.
    const { calls } = captureUrl();

    await durableClient.runs(undefined, ['etl', 'nightly'], undefined, {
      namespace: ['acme', 'globex'],
    });

    expect(clauses(calls[0])).toEqual([
      { field: 'tag', operator: 'in', value: ['etl', 'nightly'] },
      { field: 'namespace', operator: 'in', value: ['acme', 'globex'] },
    ]);
  });

  it('translates an attribute predicate into a typed clause on its key', async () => {
    const { calls } = captureUrl();

    await durableClient.runs(undefined, undefined, ['amount:gte:200', 'tier:in:pro|enterprise']);

    expect(clauses(calls[0])).toEqual([
      { field: 'attr.amount', operator: 'gte', value: 200 },
      { field: 'attr.tier', operator: 'in', value: ['pro', 'enterprise'] },
    ]);
  });

  it('scopes a bulk action by the same facets, so it cannot reach wider than the list', async () => {
    const { calls } = captureUrl();
    await durableClient.bulk('cancel', {
      status: 'dead',
      namespace: 'acme',
      origin: '@dudousxd/nestjs-agent',
    });
    expect(clauses(calls[0])).toEqual([
      { field: 'status', operator: 'equals', value: 'dead' },
      { field: 'namespace', operator: 'equals', value: 'acme' },
      { field: 'origin', operator: 'equals', value: '@dudousxd/nestjs-agent' },
    ]);
  });
});

describe('durableClient: 401 handling (session gone mid-console)', () => {
  beforeEach(() => {
    (globalThis as { window?: FakeWindow }).window = {
      __DURABLE_BASE__: '/durable',
      location: { href: '', pathname: '/durable/runs/abc', search: '?tab=timeline' },
    };
  });

  afterEach(() => {
    // biome-ignore lint/performance/noDelete: test cleanup restoring "no window" (node env), not a hot path.
    delete (globalThis as { window?: FakeWindow }).window;
    vi.unstubAllGlobals();
  });

  it('sends the operator to the login page (with returnTo) when the server offers Mode B', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ auth: { modes: ['login'] } }, 401)),
    );

    await expect(durableClient.runs()).rejects.toThrow();

    const win = (globalThis as unknown as { window: FakeWindow }).window;
    expect(win.location.href).toBe(
      '/durable/login?returnTo=%2Fdurable%2Fruns%2Fabc%3Ftab%3Dtimeline',
    );
  });

  it('sends the operator to the UI mount (renders the Mode-A session-required page) when only session mode is offered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ auth: { modes: ['session'] } }, 401)),
    );

    await expect(durableClient.runs()).rejects.toThrow();

    const win = (globalThis as unknown as { window: FakeWindow }).window;
    expect(win.location.href).toBe('/durable');
  });

  it('falls back to the UI mount when an older server sends a bare 401 with no auth info', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));

    await expect(durableClient.runs()).rejects.toThrow();

    const win = (globalThis as unknown as { window: FakeWindow }).window;
    expect(win.location.href).toBe('/durable');
  });

  it('does not surface the raw "401 Unauthorized" status text as the rejection message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ auth: { modes: ['login'] } }, 401)),
    );

    await expect(durableClient.runs()).rejects.not.toMatchObject({
      message: '401 Unauthorized',
    });
  });
});

describe('durableClient: paging and the unattributed bucket', () => {
  function captureUrl(): { calls: string[] } {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(jsonResponse([], 200));
      }),
    );
    return { calls };
  }

  afterEach(() => vi.unstubAllGlobals());

  it('bounds the listing with limit and offset', async () => {
    // Inside the filter envelope, not as `paginate`: the console's "show more" grows ONE window
    // rather than stepping through pages, and `paginate.size` is capped server-side by
    // `maxPageSize` — a cap that would silently stop "show more" at 100 rows.
    const { calls } = captureUrl();

    await durableClient.runs(undefined, undefined, undefined, { limit: 100, offset: 200 });

    expect(calls[0]).toContain('filter[limit]=100');
    expect(calls[0]).toContain('filter[offset]=200');
  });

  it('asks for the unattributed bucket as an ABSENCE, never as an origin VALUE', async () => {
    // Any reserved `origin` string is a package name someone can legitimately publish, so the
    // absence travels as the one operator that can select it.
    const { calls } = captureUrl();

    await durableClient.runs(undefined, undefined, undefined, { origin: null });

    // `isNull` selects an absence, so it carries no operand of its own.
    expect(clauses(calls[0])).toEqual([{ field: 'origin', operator: 'isNull', value: undefined }]);
  });

  it('sends a concrete origin as an equality, unchanged', async () => {
    const { calls } = captureUrl();

    await durableClient.runs(undefined, undefined, undefined, { origin: '@dudousxd/agent' });

    expect(clauses(calls[0])).toEqual([
      { field: 'origin', operator: 'equals', value: '@dudousxd/agent' },
    ]);
  });

  it('sends a status SET as one clause, which the server ORs', async () => {
    const { calls } = captureUrl();

    await durableClient.runs(undefined, undefined, undefined, {
      statuses: ['running', 'suspended'],
    });

    expect(clauses(calls[0])).toEqual([
      { field: 'status', operator: 'in', value: ['running', 'suspended'] },
    ]);
  });

  it('carries the unattributed bucket into a BULK action, so it cannot act wider than the list', async () => {
    const { calls } = captureUrl();

    await durableClient.bulk('cancel', { origin: null });

    // `isNull` selects an absence, so it carries no operand of its own.
    expect(clauses(calls[0])).toEqual([{ field: 'origin', operator: 'isNull', value: undefined }]);
  });

  it('asks the facets endpoint only for the axes it does NOT report', async () => {
    const { calls } = captureUrl();

    await durableClient.facets('tier:pro', ['amount:gte:200'], 'acme');

    expect(calls[0]).toContain('/runs/facets?');
    expect(clauses(calls[0])).toEqual([
      { field: 'tag', operator: 'equals', value: 'tier:pro' },
      { field: 'namespace', operator: 'equals', value: 'acme' },
      { field: 'attr.amount', operator: 'gte', value: 200 },
    ]);
    expect(calls[0]).not.toContain('filter[limit]');
  });

  it('scopes a value picker by the rest of the filter, and bounds what it returns', async () => {
    // The point of the picker: choose a tenant, and the tag list narrows to that tenant's tags. A
    // picker that ignored the active filters would offer values whose result set is empty.
    const { calls } = captureUrl();

    await durableClient.values('tag', { namespace: ['acme'] }, { limit: 20 });

    expect(calls[0]).toContain('/runs/values?');
    expect(clauses(calls[0])).toEqual([{ field: 'namespace', operator: 'equals', value: 'acme' }]);
    expect(calls[0]).toContain('groupByCount[field]=tag');
    expect(calls[0]).toContain('groupByCount[limit]=20');
  });
});
