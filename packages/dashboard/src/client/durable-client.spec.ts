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
