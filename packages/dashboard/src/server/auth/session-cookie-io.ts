import { parseCookieHeader, serializeSetCookie } from './cookie-header.js';
import type { ResolvedDashboardAuth } from './dashboard-auth-config.js';
import { isHttpsRequest, readCookieHeader } from './request.js';
import { appendSetCookie } from './response.js';
import {
  type DashboardSession,
  type DashboardSessionUser,
  signSessionCookie,
  verifySessionCookie,
} from './session-cookie.js';

/** Cookie name carrying the signed dashboard session. */
export const SESSION_COOKIE_NAME = 'durable_dashboard_session';

/**
 * `Path=/`, deliberately not scoped to `basePath`/`apiBasePath`: the two mounts are independently
 * configurable (`DurableDashboardModule.forRoot({ basePath, apiBasePath })`) and can live at
 * unrelated paths (e.g. `/durable` UI + `/api/durable` API) — a cookie scoped to either one alone
 * would not reach the other. The cookie is `HttpOnly` + signed + short-lived, so the broader scope
 * is a reasonable trade for correctness across any mount configuration.
 */
const COOKIE_PATH = '/';

/**
 * Sign a fresh session for `user` and append it as a `Set-Cookie` on the response, `Secure` when
 * the request is https.
 */
export function issueSessionCookie(
  user: DashboardSessionUser,
  context: {
    auth: ResolvedDashboardAuth;
    request: unknown;
    response: unknown;
    now?: number;
  },
): void {
  const value = signSessionCookie(user, {
    secret: context.auth.secret,
    ttlMs: context.auth.ttlMs,
    ...(context.now !== undefined ? { now: context.now } : {}),
  });
  const cookie = serializeSetCookie(SESSION_COOKIE_NAME, value, {
    path: COOKIE_PATH,
    maxAgeSeconds: Math.floor(context.auth.ttlMs / 1000),
    secure: isHttpsRequest(context.request),
  });
  appendSetCookie(context.response, cookie);
}

/** Append a cookie-clearing `Set-Cookie` (Max-Age=0). */
export function clearSessionCookie(context: { request: unknown; response: unknown }): void {
  const cookie = serializeSetCookie(SESSION_COOKIE_NAME, '', {
    path: COOKIE_PATH,
    maxAgeSeconds: 0,
    secure: isHttpsRequest(context.request),
    clear: true,
  });
  appendSetCookie(context.response, cookie);
}

/** Read + verify the session cookie on `request`, or `null` when absent/tampered/expired. */
export function readSessionFromRequest(
  auth: ResolvedDashboardAuth,
  request: unknown,
): DashboardSession | null {
  const cookieValue = parseCookieHeader(readCookieHeader(request))[SESSION_COOKIE_NAME];
  if (cookieValue === undefined) return null;
  return verifySessionCookie(cookieValue, { secret: auth.secret });
}

/**
 * Sliding renewal: when a valid cookie is past 50% of its TTL, re-issue a fresh one so an active
 * session never expires mid-use. Appends a new `Set-Cookie` (preserving any others already queued).
 */
export function maybeRenewSession(
  auth: ResolvedDashboardAuth,
  session: DashboardSession,
  request: unknown,
  response: unknown,
): void {
  const now = Date.now();
  if (now - session.iat <= auth.ttlMs / 2) return;
  issueSessionCookie(
    {
      id: session.sub,
      ...(session.name !== undefined ? { name: session.name } : {}),
      roles: session.roles,
    },
    { auth, request, response, now },
  );
}
