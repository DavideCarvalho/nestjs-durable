import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { resolveDashboardAuth } from './auth/dashboard-auth-config';
import { DashboardLoginRedirectException } from './auth/login-redirect.exception';
import { signSessionCookie } from './auth/session-cookie';
import { DurableApiSessionGuard, DurableUiSessionGuard } from './durable-session.guard';

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

describe('DurableUiSessionGuard (absent-option)', () => {
  it('is a no-op — always allows — when dashboardAuth is not configured', () => {
    const guard = new DurableUiSessionGuard(null, BASE_PATH);
    const ctx = makeContext({ headers: {} }, makeResponse().raw);
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe('DurableUiSessionGuard (dashboardAuth configured)', () => {
  const auth = resolveDashboardAuth({ secret: SECRET, login: () => null });

  it('allows a request carrying a valid session cookie', () => {
    const guard = new DurableUiSessionGuard(auth, BASE_PATH);
    const request = { headers: { cookie: `durable_dashboard_session=${validCookie()}` } };
    const ctx = makeContext(request, makeResponse().raw);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('redirects (302, not 401) a page request with no cookie, carrying ?returnTo', () => {
    const guard = new DurableUiSessionGuard(auth, BASE_PATH);
    const request = { headers: {}, originalUrl: '/durable/runs/abc' };
    const ctx = makeContext(request, makeResponse().raw);
    let caught: unknown;
    try {
      guard.canActivate(ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DashboardLoginRedirectException);
    expect((caught as DashboardLoginRedirectException).location).toBe(
      '/durable/login?returnTo=%2Fdurable%2Fruns%2Fabc',
    );
  });

  it('redirects a request with a tampered/invalid cookie', () => {
    const guard = new DurableUiSessionGuard(auth, BASE_PATH);
    const request = { headers: { cookie: 'durable_dashboard_session=garbage' }, url: '/durable' };
    const ctx = makeContext(request, makeResponse().raw);
    expect(() => guard.canActivate(ctx)).toThrow(DashboardLoginRedirectException);
  });

  it('slides renewal: re-issues the cookie once past 50% of its TTL', () => {
    const shortAuth = resolveDashboardAuth({ secret: SECRET, ttl: '2h', login: () => null });
    const guard = new DurableUiSessionGuard(shortAuth, BASE_PATH);
    const issuedAt = Date.now() - 90 * 60 * 1000; // 90m ago, past 50% of a 2h ttl
    const cookie = signSessionCookie(
      { id: 'ops' },
      { secret: SECRET, ttlMs: 2 * 60 * 60 * 1000, now: issuedAt },
    );
    const response = makeResponse();
    const request = { headers: { cookie: `durable_dashboard_session=${cookie}` } };
    expect(guard.canActivate(makeContext(request, response.raw))).toBe(true);
    expect(response.setCookies().some((c) => c.startsWith('durable_dashboard_session='))).toBe(
      true,
    );
  });
});

describe('DurableApiSessionGuard (absent-option)', () => {
  it('is a no-op — always allows — when dashboardAuth is not configured', () => {
    const guard = new DurableApiSessionGuard(null);
    const ctx = makeContext({ headers: {} }, makeResponse().raw);
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe('DurableApiSessionGuard (dashboardAuth configured)', () => {
  const auth = resolveDashboardAuth({ secret: SECRET, login: () => null });

  it('allows a request carrying a valid session cookie', () => {
    const guard = new DurableApiSessionGuard(auth);
    const request = { headers: { cookie: `durable_dashboard_session=${validCookie()}` } };
    expect(guard.canActivate(makeContext(request, makeResponse().raw))).toBe(true);
  });

  it('throws a plain 401 (not a redirect) for a missing cookie — the API is fetched, not navigated', () => {
    const guard = new DurableApiSessionGuard(auth);
    const ctx = makeContext({ headers: {} }, makeResponse().raw);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws 401 for a tampered cookie', () => {
    const guard = new DurableApiSessionGuard(auth);
    const request = { headers: { cookie: 'durable_dashboard_session=garbage' } };
    expect(() => guard.canActivate(makeContext(request, makeResponse().raw))).toThrow(
      UnauthorizedException,
    );
  });
});
