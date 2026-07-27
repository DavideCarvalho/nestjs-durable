import type { DashboardSessionUser } from './session-cookie.js';

/** Host hook for Mode A — validates the host's own auth on the raw request. */
export type SessionHook = (
  request: unknown,
) => Promise<DashboardSessionUser | null> | DashboardSessionUser | null;

/** Host hook for Mode B — validates submitted credentials from the built-in login page. */
export type LoginHook = (
  username: string,
  password: string,
) => Promise<DashboardSessionUser | null> | DashboardSessionUser | null;

export type AuthMode = 'session' | 'login';

/**
 * Author-facing `dashboardAuth` option on `DurableDashboardModule.forRoot`/`forRootAsync`. Gates
 * BOTH the SPA (a full-page navigation redirected to a server-rendered login page) and the JSON
 * API (a plain `401`) behind a signed session cookie, mirroring `@dudousxd/nestjs-telescope`'s
 * `dashboardAuth` mechanism (same HMAC-SHA256 cookie, same fail-closed validation). Two ways to
 * mint that cookie: Mode A (`session`) — the host frontend, already carrying its own auth, POSTs
 * to `<basePath>/session` and the host hook decides; or Mode B (`login`) — the built-in,
 * dependency-free server-rendered login page (`GET <basePath>/login`). At least one of the two is
 * required so an un-mintable gate is a boot error, not a silently-open (or silently-stuck) console.
 */
export interface DashboardAuthOptions {
  /** REQUIRED HMAC-SHA256 signing key. Missing/empty => boot error (fail closed). */
  secret: string;
  /** Cookie TTL as a duration string (`'8h'`, `'30m'`, `'7d'`). Default `'8h'`. */
  ttl?: string;
  /** Mode A: validates the host's own auth on the raw request POSTed to `<basePath>/session`;
   *  return the session user, or `null` to deny. Thrown errors are treated as a denial (logged
   *  once, never surfaced to the client). */
  session?: SessionHook;
  /** Mode B: validates submitted username/password from the built-in login page; return the
   *  session user, or `null` to deny. Thrown errors are treated as a denial (logged once, never
   *  surfaced to the client). */
  login?: LoginHook;
}

/** Resolved, validated `dashboardAuth` config shared by the guards, auth controller, and login page. */
export interface ResolvedDashboardAuth {
  secret: string;
  ttlMs: number;
  modes: AuthMode[];
  session?: SessionHook;
  login?: LoginHook;
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
 * secret, or missing both a `session` and a `login` hook — the host learns immediately rather than
 * shipping an un-mintable gate.
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
  const modes: AuthMode[] = [];
  if (options.session !== undefined) {
    if (typeof options.session !== 'function') {
      throw new Error('DurableDashboardModule: dashboardAuth.session must be a function.');
    }
    modes.push('session');
  }
  if (options.login !== undefined) {
    if (typeof options.login !== 'function') {
      throw new Error('DurableDashboardModule: dashboardAuth.login must be a function.');
    }
    modes.push('login');
  }
  if (modes.length === 0) {
    throw new Error(
      'DurableDashboardModule: dashboardAuth needs at least one of `session` or `login` ' +
        '(otherwise the cookie can never be minted). Failing closed.',
    );
  }
  return {
    secret: options.secret,
    ttlMs: durationToMs(options.ttl ?? DEFAULT_TTL),
    modes,
    ...(options.session !== undefined ? { session: options.session } : {}),
    ...(options.login !== undefined ? { login: options.login } : {}),
  };
}
