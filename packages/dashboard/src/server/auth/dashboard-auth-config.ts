import type { DashboardSessionUser } from './session-cookie.js';

/** Host hook validating submitted credentials from the built-in login page. */
export type LoginHook = (
  username: string,
  password: string,
) => Promise<DashboardSessionUser | null> | DashboardSessionUser | null;

/**
 * Author-facing `dashboardAuth` option on `DurableDashboardModule.forRoot`/`forRootAsync`. Gates
 * BOTH the SPA (a full-page navigation redirected to a server-rendered login page) and the JSON
 * API (a plain `401`) behind a signed session cookie, mirroring `@dudousxd/nestjs-telescope`'s
 * `dashboardAuth` mechanism (same HMAC-SHA256 cookie, same fail-closed validation). Unlike
 * Telescope's dashboard — a client-rendered SPA that can grow its own login screen — the durable
 * dashboard's bundled React app stays untouched: the login screen here is a small, dependency-free
 * server-rendered HTML page (`GET <basePath>/login`), so gating the SPA shell itself with a real
 * redirect doesn't require rebuilding or extending the Vite bundle.
 */
export interface DashboardAuthOptions {
  /** REQUIRED HMAC-SHA256 signing key. Missing/empty => boot error (fail closed). */
  secret: string;
  /** Cookie TTL as a duration string (`'8h'`, `'30m'`, `'7d'`). Default `'8h'`. */
  ttl?: string;
  /** Validates submitted username/password; return the session user, or `null` to deny. Thrown
   *  errors are treated as a denial (logged once, never surfaced to the client). */
  login: LoginHook;
}

/** Resolved, validated `dashboardAuth` config shared by the guards, auth controller, and login page. */
export interface ResolvedDashboardAuth {
  secret: string;
  ttlMs: number;
  login: LoginHook;
}

/** DI token carrying the resolved `dashboardAuth` config (`ResolvedDashboardAuth | null`). */
export const DASHBOARD_AUTH = Symbol('DASHBOARD_AUTH');

const DEFAULT_TTL = '8h';
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** Parse a `'<number><s|m|h|d>'` duration to ms; falls back to the 8h default on a bad value. */
function durationToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return DEFAULT_TTL_MS;
  const unit = DURATION_UNITS[match[2] ?? ''];
  if (unit === undefined) return DEFAULT_TTL_MS;
  return Number(match[1]) * unit;
}

/**
 * Validate + resolve the `dashboardAuth` option. Returns `null` when unconfigured (today's
 * unauthenticated behavior, unchanged). Throws at boot (fail closed) when configured but missing a
 * secret or a `login` hook — the host learns immediately rather than shipping an un-mintable gate.
 */
export function resolveDashboardAuth(
  options: DashboardAuthOptions | undefined,
): ResolvedDashboardAuth | null {
  if (options === undefined) return null;
  if (typeof options.secret !== 'string' || options.secret === '') {
    throw new Error(
      'DurableDashboardModule: dashboardAuth.secret is required and must be a non-empty string ' +
        '(HMAC-SHA256 signing key, 32+ bytes recommended). Failing closed.',
    );
  }
  if (typeof options.login !== 'function') {
    throw new Error('DurableDashboardModule: dashboardAuth.login is required (a login hook).');
  }
  return {
    secret: options.secret,
    ttlMs: durationToMs(options.ttl ?? DEFAULT_TTL),
    login: options.login,
  };
}
