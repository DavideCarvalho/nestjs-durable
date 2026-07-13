import { describe, expect, it } from 'vitest';
import { resolveDashboardAuth } from './dashboard-auth-config';

describe('resolveDashboardAuth', () => {
  it('returns null when dashboardAuth is not configured (absent-option)', () => {
    expect(resolveDashboardAuth(undefined)).toBeNull();
  });

  it('resolves a valid config with the default 8h ttl', () => {
    const login = () => null;
    const resolved = resolveDashboardAuth({ secret: 'x'.repeat(32), login });

    expect(resolved).toEqual({ secret: 'x'.repeat(32), ttlMs: 8 * 60 * 60 * 1000, login });
  });

  it('parses a custom ttl string', () => {
    const resolved = resolveDashboardAuth({ secret: 's', ttl: '30m', login: () => null });
    expect(resolved?.ttlMs).toBe(30 * 60 * 1000);
  });

  it('falls back to the 8h default on a malformed ttl', () => {
    const resolved = resolveDashboardAuth({
      secret: 's',
      ttl: 'not-a-duration',
      login: () => null,
    });
    expect(resolved?.ttlMs).toBe(8 * 60 * 60 * 1000);
  });

  it('throws (fail closed) when secret is missing', () => {
    expect(() => resolveDashboardAuth({ secret: '', login: () => null })).toThrow(
      /secret is required/,
    );
  });

  it('throws (fail closed) when login is missing', () => {
    expect(() =>
      // @ts-expect-error: exercising the missing-login boot guard (a non-TS caller could omit it)
      resolveDashboardAuth({ secret: 's' }),
    ).toThrow(/login is required/);
  });
});
