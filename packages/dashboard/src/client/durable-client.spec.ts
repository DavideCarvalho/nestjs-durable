import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { durableClient } from './durable-client.js';

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
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('tag')).toBe('tier:pro');
    expect(query.get('namespace')).toBe('acme');
    expect(query.get('origin')).toBe('@dudousxd/nestjs-catalog-pipeline');
  });

  it('scopes a bulk action by the same facets, so it cannot reach wider than the list', async () => {
    const { calls } = captureUrl();
    await durableClient.bulk('cancel', {
      status: 'dead',
      namespace: 'acme',
      origin: '@dudousxd/nestjs-agent',
    });
    const query = new URLSearchParams(calls[0]?.split('?')[1] ?? '');
    expect(query.get('status')).toBe('dead');
    expect(query.get('namespace')).toBe('acme');
    expect(query.get('origin')).toBe('@dudousxd/nestjs-agent');
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
    const { calls } = captureUrl();

    await durableClient.runs(undefined, undefined, undefined, { limit: 100, offset: 200 });

    expect(calls[0]).toContain('limit=100');
    expect(calls[0]).toContain('offset=200');
  });

  it('asks for the unattributed bucket by its own param, never as an origin VALUE', async () => {
    // Any reserved `origin` string is a package name someone can legitimately publish, so absence
    // gets its own spelling on the wire.
    const { calls } = captureUrl();

    await durableClient.runs(undefined, undefined, undefined, { origin: null });

    expect(calls[0]).toContain('unattributed=true');
    expect(calls[0]).not.toContain('origin=');
  });

  it('sends a concrete origin as `origin`, unchanged', async () => {
    const { calls } = captureUrl();

    await durableClient.runs(undefined, undefined, undefined, { origin: '@dudousxd/agent' });

    expect(calls[0]).toContain('origin=%40dudousxd%2Fagent');
    expect(calls[0]).not.toContain('unattributed');
  });

  it('repeats `status` for a status SET, which the server ORs', async () => {
    const { calls } = captureUrl();

    await durableClient.runs(undefined, undefined, undefined, {
      statuses: ['running', 'suspended'],
    });

    expect(calls[0]).toContain('status=running');
    expect(calls[0]).toContain('status=suspended');
  });

  it('carries the unattributed bucket into a BULK action, so it cannot act wider than the list', async () => {
    const { calls } = captureUrl();

    await durableClient.bulk('cancel', { origin: null });

    expect(calls[0]).toContain('unattributed=true');
  });

  it('asks the facets endpoint only for the axes it does NOT report', async () => {
    const { calls } = captureUrl();

    await durableClient.facets('tier:pro', ['amount:gte:200'], 'acme');

    expect(calls[0]).toContain('/runs/facets?');
    expect(calls[0]).toContain('tag=tier%3Apro');
    expect(calls[0]).toContain('namespace=acme');
    expect(calls[0]).not.toContain('status=');
    expect(calls[0]).not.toContain('origin=');
    expect(calls[0]).not.toContain('limit=');
  });
});
