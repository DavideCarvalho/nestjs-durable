import { describe, expect, it, vi } from 'vitest';
import { type DashboardAuthOptions, resolveDashboardAuth } from './dashboard-auth-config.js';
import { maybeRenewSession } from './session-cookie-io.js';
import { signSessionCookie, verifySessionCookie } from './session-cookie.js';

const SECRET = 'a-very-not-secret-test-key';

/** `resolveDashboardAuth`, asserting the config was valid (never `null` for these fixtures). */
function resolveAuth(options: DashboardAuthOptions) {
  const auth = resolveDashboardAuth(options);
  if (!auth) throw new Error('expected dashboardAuth to resolve for this test fixture');
  return auth;
}

/** Minimal Node-response double recording Set-Cookie writes, over the `appendSetCookie` contract. */
function mockResponse(): {
  getHeader: (name: string) => unknown;
  setHeader: (name: string, value: unknown) => void;
} {
  const headers: Record<string, unknown> = {};
  return {
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
  };
}

/** Read the queued `Set-Cookie` header(s) off a `mockResponse()`. */
function setCookiesOn(response: ReturnType<typeof mockResponse>): string[] {
  const current = response.getHeader('set-cookie');
  return Array.isArray(current) ? current.filter((c): c is string => typeof c === 'string') : [];
}

describe('session cookie sign/verify (round-trip)', () => {
  it('signs and verifies a session, round-tripping id/name/roles', () => {
    const now = Date.now();
    const cookie = signSessionCookie(
      { id: 'ops', name: 'Ops', roles: ['admin'] },
      { secret: SECRET, ttlMs: 60_000, now },
    );

    const session = verifySessionCookie(cookie, { secret: SECRET, now });

    expect(session).toEqual({
      sub: 'ops',
      name: 'Ops',
      roles: ['admin'],
      iat: now,
      exp: now + 60_000,
    });
  });

  it('defaults roles to an empty array when omitted', () => {
    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 60_000 });
    const session = verifySessionCookie(cookie, { secret: SECRET });
    expect(session?.roles).toEqual([]);
    expect(session?.name).toBeUndefined();
  });

  it('rejects a cookie signed with a different secret (tamper detection)', () => {
    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 60_000 });
    expect(verifySessionCookie(cookie, { secret: 'wrong-secret' })).toBeNull();
  });

  it('rejects a cookie whose payload was tampered with (signature no longer matches)', () => {
    const cookie = signSessionCookie({ id: 'ops', roles: [] }, { secret: SECRET, ttlMs: 60_000 });
    const [payload, signature] = cookie.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({ sub: 'admin', roles: ['admin'], iat: Date.now(), exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url');
    expect(verifySessionCookie(`${tamperedPayload}.${signature}`, { secret: SECRET })).toBeNull();
    expect(payload).toBeDefined();
  });

  it('rejects an expired cookie past the 30s grace', () => {
    const now = Date.now();
    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 1000, now });
    expect(verifySessionCookie(cookie, { secret: SECRET, now: now + 1000 + 30_001 })).toBeNull();
  });

  it('accepts a cookie just past expiry but within the 30s clock-skew grace', () => {
    const now = Date.now();
    const cookie = signSessionCookie({ id: 'ops' }, { secret: SECRET, ttlMs: 1000, now });
    expect(
      verifySessionCookie(cookie, { secret: SECRET, now: now + 1000 + 10_000 }),
    ).not.toBeNull();
  });

  it('never throws on garbage input', () => {
    expect(verifySessionCookie('', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('not-a-cookie', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('.', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('abc.', { secret: SECRET })).toBeNull();
  });
});

describe('maybeRenewSession (sliding renewal + revalidation)', () => {
  // `exp` is not read by `maybeRenewSession` (renewal is gated on `iat` only, see
  // session-cookie-io.ts) but the fixtures still need a well-typed `DashboardSession`.
  const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
  const HALF_LIFE_PASSED_IAT = Date.now() - 5 * 60 * 60 * 1000;
  const HALF_LIFE_PASSED = {
    iat: HALF_LIFE_PASSED_IAT,
    exp: HALF_LIFE_PASSED_IAT + DEFAULT_TTL_MS,
    sub: '7',
    roles: ['admin'],
  };

  it('does not call revalidate before half the TTL has passed', async () => {
    const revalidate = vi.fn().mockResolvedValue(true);
    const auth = resolveAuth({ secret: 's'.repeat(32), session: () => null, revalidate });
    const now = Date.now();
    const fresh = { iat: now, exp: now + DEFAULT_TTL_MS, sub: '7', roles: ['admin'] };
    await maybeRenewSession(auth, fresh, { headers: {} }, mockResponse());
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('renews when revalidate approves', async () => {
    const auth = resolveAuth({
      secret: 's'.repeat(32),
      session: () => null,
      revalidate: () => true,
    });
    const response = mockResponse();
    await expect(
      maybeRenewSession(auth, HALF_LIFE_PASSED, { headers: {} }, response),
    ).resolves.toBe(true);
    expect(setCookiesOn(response)[0]).toContain('durable_dashboard_session=');
  });

  it('clears the cookie and denies when revalidate rejects', async () => {
    const auth = resolveAuth({
      secret: 's'.repeat(32),
      session: () => null,
      revalidate: () => false,
    });
    const response = mockResponse();
    await expect(
      maybeRenewSession(auth, HALF_LIFE_PASSED, { headers: {} }, response),
    ).resolves.toBe(false);
    expect(setCookiesOn(response)[0]).toContain('Max-Age=0');
  });

  it('fails closed when revalidate throws', async () => {
    const auth = resolveAuth({
      secret: 's'.repeat(32),
      session: () => null,
      revalidate: () => {
        throw new Error('db down');
      },
    });
    await expect(
      maybeRenewSession(auth, HALF_LIFE_PASSED, { headers: {} }, mockResponse()),
    ).resolves.toBe(false);
  });

  it('renews without a revalidate hook (unchanged behaviour)', async () => {
    const auth = resolveAuth({ secret: 's'.repeat(32), session: () => null });
    await expect(
      maybeRenewSession(auth, HALF_LIFE_PASSED, { headers: {} }, mockResponse()),
    ).resolves.toBe(true);
  });
});
