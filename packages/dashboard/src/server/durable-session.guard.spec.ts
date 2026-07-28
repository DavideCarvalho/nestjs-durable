import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { resolveDashboardAuth } from './auth/dashboard-auth-config.js';
import { DashboardLoginRedirectException } from './auth/login-redirect.exception.js';
import { signSessionCookie } from './auth/session-cookie.js';
import { DashboardSessionRequiredException } from './auth/session-required.exception.js';
import { DurableApiSessionGuard, DurableUiSessionGuard } from './durable-session.guard.js';

const SECRET = 'guard-spec-secret-key-0123456789-abcdef';
const BASE_PATH = '/durable';

/** Minimal Node-response double recording Set-Cookie writes. */
function makeResponse(): {
  raw: { getHeader: (n: string) => unknown; setHeader: (n: string, v: unknown) => void };
  setCookies: () => string[];
} {
  const headers: Record<string, unknown> = {};
  return {
    raw: {
      getHeader: (name) => headers[name.toLowerCase()],
      setHeader: (name, value) => {
        headers[name.toLowerCase()] = value;
      },
    },
    setCookies: () => {
      const current = headers['set-cookie'];
      return Array.isArray(current)
        ? current.filter((c): c is string => typeof c === 'string')
        : [];
    },
  };
}

function makeContext(request: unknown, response: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ExecutionContext;
}

function validCookie(now = Date.now()): string {
  return signSessionCookie(
    { id: 'ops', roles: ['admin'] },
    { secret: SECRET, ttlMs: 8 * 60 * 60 * 1000, now },
  );
}

/** A signed cookie issued far enough in the past to be due for sliding renewal. */
function signedCookieOlderThanHalfTtl(auth: ReturnType<typeof resolveDashboardAuth>): string {
  const ttlMs = auth?.ttlMs ?? 8 * 60 * 60 * 1000;
  const issuedAt = Date.now() - ttlMs * 0.75;
  const cookieValue = signSessionCookie(
    { id: 'ops', roles: ['admin'] },
    { secret: SECRET, ttlMs, now: issuedAt },
  );
  return `durable_dashboard_session=${cookieValue}`;
}

describe('DurableUiSessionGuard (absent-option)', () => {
  it('is a no-op — always allows — when dashboardAuth is not configured', async () => {
    const guard = new DurableUiSessionGuard(null, BASE_PATH);
    const ctx = makeContext({ headers: {} }, makeResponse().raw);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe('DurableUiSessionGuard (dashboardAuth configured)', () => {
  const auth = resolveDashboardAuth({ secret: SECRET, login: () => null });

  it('allows a request carrying a valid session cookie', async () => {
    const guard = new DurableUiSessionGuard(auth, BASE_PATH);
    const request = { headers: { cookie: `durable_dashboard_session=${validCookie()}` } };
    const ctx = makeContext(request, makeResponse().raw);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('redirects (302, not 401) a page request with no cookie, carrying ?returnTo', async () => {
    const guard = new DurableUiSessionGuard(auth, BASE_PATH);
    const request = { headers: {}, originalUrl: '/durable/runs/abc' };
    const ctx = makeContext(request, makeResponse().raw);
    let caught: unknown;
    try {
      await guard.canActivate(ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DashboardLoginRedirectException);
    expect((caught as DashboardLoginRedirectException).location).toBe(
      '/durable/login?returnTo=%2Fdurable%2Fruns%2Fabc',
    );
  });

  it('redirects a request with a tampered/invalid cookie', async () => {
    const guard = new DurableUiSessionGuard(auth, BASE_PATH);
    const request = { headers: { cookie: 'durable_dashboard_session=garbage' }, url: '/durable' };
    const ctx = makeContext(request, makeResponse().raw);
    await expect(guard.canActivate(ctx)).rejects.toThrow(DashboardLoginRedirectException);
  });

  it('serves the session-required page (not a login redirect) when only Mode A is configured', async () => {
    const modeAAuth = resolveDashboardAuth({ secret: SECRET, session: () => null });
    const guard = new DurableUiSessionGuard(modeAAuth, BASE_PATH);
    const ctx = makeContext({ headers: {} }, makeResponse().raw);
    await expect(guard.canActivate(ctx)).rejects.toThrow(DashboardSessionRequiredException);
  });

  it('slides renewal: re-issues the cookie once past 50% of its TTL', async () => {
    const shortAuth = resolveDashboardAuth({ secret: SECRET, ttl: '2h', login: () => null });
    const guard = new DurableUiSessionGuard(shortAuth, BASE_PATH);
    const issuedAt = Date.now() - 90 * 60 * 1000; // 90m ago, past 50% of a 2h ttl
    const cookie = signSessionCookie(
      { id: 'ops' },
      { secret: SECRET, ttlMs: 2 * 60 * 60 * 1000, now: issuedAt },
    );
    const response = makeResponse();
    const request = { headers: { cookie: `durable_dashboard_session=${cookie}` } };
    await expect(guard.canActivate(makeContext(request, response.raw))).resolves.toBe(true);
    expect(response.setCookies().some((c) => c.startsWith('durable_dashboard_session='))).toBe(
      true,
    );
  });

  it('redirects (not a 401) when revalidate revokes a renewable session, Mode B configured', async () => {
    const revalidateAuth = resolveDashboardAuth({
      secret: SECRET,
      login: () => null,
      revalidate: () => false,
    });
    const guard = new DurableUiSessionGuard(revalidateAuth, BASE_PATH);
    const request = { headers: { cookie: signedCookieOlderThanHalfTtl(revalidateAuth) } };
    const ctx = makeContext(request, makeResponse().raw);
    await expect(guard.canActivate(ctx)).rejects.toThrow(DashboardLoginRedirectException);
  });

  it('serves the session-required page when revalidate revokes a renewable session, Mode A only', async () => {
    const revalidateModeAAuth = resolveDashboardAuth({
      secret: SECRET,
      session: () => null,
      revalidate: () => false,
    });
    const guard = new DurableUiSessionGuard(revalidateModeAAuth, BASE_PATH);
    const request = { headers: { cookie: signedCookieOlderThanHalfTtl(revalidateModeAAuth) } };
    const ctx = makeContext(request, makeResponse().raw);
    await expect(guard.canActivate(ctx)).rejects.toThrow(DashboardSessionRequiredException);
  });
});

describe('DurableApiSessionGuard (absent-option)', () => {
  it('is a no-op — always allows — when dashboardAuth is not configured', async () => {
    const guard = new DurableApiSessionGuard(null);
    const ctx = makeContext({ headers: {} }, makeResponse().raw);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe('DurableApiSessionGuard (dashboardAuth configured)', () => {
  const auth = resolveDashboardAuth({ secret: SECRET, login: () => null });

  it('allows a request carrying a valid session cookie', async () => {
    const guard = new DurableApiSessionGuard(auth);
    const request = { headers: { cookie: `durable_dashboard_session=${validCookie()}` } };
    await expect(guard.canActivate(makeContext(request, makeResponse().raw))).resolves.toBe(true);
  });

  it('throws a plain 401 (not a redirect) for a missing cookie — the API is fetched, not navigated', async () => {
    const guard = new DurableApiSessionGuard(auth);
    const ctx = makeContext({ headers: {} }, makeResponse().raw);
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws 401 for a tampered cookie', async () => {
    const guard = new DurableApiSessionGuard(auth);
    const request = { headers: { cookie: 'durable_dashboard_session=garbage' } };
    await expect(guard.canActivate(makeContext(request, makeResponse().raw))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('denies the API when revalidate revokes a renewable session', async () => {
    const revalidateAuth = resolveDashboardAuth({
      secret: SECRET,
      session: () => null,
      revalidate: () => false,
    });
    const guard = new DurableApiSessionGuard(revalidateAuth);
    const request = { headers: { cookie: signedCookieOlderThanHalfTtl(revalidateAuth) } };
    await expect(guard.canActivate(makeContext(request, makeResponse().raw))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
