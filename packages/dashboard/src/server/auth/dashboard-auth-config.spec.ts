import { describe, expect, it } from 'vitest';
import { resolveDashboardAuth } from './dashboard-auth-config.js';

describe('resolveDashboardAuth', () => {
  it('returns null when dashboardAuth is not configured (absent-option)', () => {
    expect(resolveDashboardAuth(undefined)).toBeNull();
  });

  it('resolves a valid config with the default 8h ttl', () => {
    const login = () => null;
    const resolved = resolveDashboardAuth({ secret: 'x'.repeat(32), login });

    expect(resolved).toEqual({
      secret: 'x'.repeat(32),
      ttlMs: 8 * 60 * 60 * 1000,
      modes: ['login'],
      login,
    });
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

  it('resolves with only a session hook (Mode A)', () => {
    const session = () => null;
    const resolved = resolveDashboardAuth({ secret: 'x'.repeat(32), session });
    expect(resolved).toEqual({
      secret: 'x'.repeat(32),
      ttlMs: 8 * 60 * 60 * 1000,
      modes: ['session'],
      session,
    });
  });

  it('resolves with both hooks and reports both modes', () => {
    const session = () => null;
    const login = () => null;
    const resolved = resolveDashboardAuth({ secret: 's'.repeat(32), session, login });
    expect(resolved?.modes).toEqual(['session', 'login']);
  });

  it('throws (fail closed) when neither hook is given', () => {
    expect(() => resolveDashboardAuth({ secret: 's'.repeat(32) })).toThrow(
      /at least one of `session` or `login`/,
    );
  });

  it('throws (fail closed) when session is present but not a function', () => {
    expect(() =>
      resolveDashboardAuth({
        secret: 's'.repeat(32),
        // @ts-expect-error: exercising the wrong-type boot guard (a non-TS caller could pass this)
        session: 'not-a-function',
      }),
    ).toThrow(/dashboardAuth\.session must be a function/);
  });

  it('throws (fail closed) when login is present but not a function', () => {
    expect(() =>
      resolveDashboardAuth({
        secret: 's'.repeat(32),
        // @ts-expect-error: exercising the wrong-type boot guard (a non-TS caller could pass this)
        login: 'not-a-function',
      }),
    ).toThrow(/dashboardAuth\.login must be a function/);
  });

  it('throws (fail closed) when revalidate is present but not a function', () => {
    expect(() =>
      resolveDashboardAuth({
        secret: 's'.repeat(32),
        login: () => null,
        // @ts-expect-error: exercising the wrong-type boot guard (a non-TS caller could pass this)
        revalidate: 'not-a-function',
      }),
    ).toThrow(/dashboardAuth\.revalidate must be a function/);
  });
});
