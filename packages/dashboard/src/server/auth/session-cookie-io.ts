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
 * Sliding renewal + revalidation. When a valid cookie is past 50% of its TTL, re-issue a fresh one
 * so an active session never expires mid-use — but first give the host's `revalidate` hook a say,
 * so a deactivated or demoted user loses access instead of riding a self-renewing cookie forever.
 *
 * Returns `false` when the session was revoked (the clearing `Set-Cookie` is already queued and the
 * caller must deny the request); `true` otherwise, including when no renewal was due.
 */
export async function maybeRenewSession(
  auth: ResolvedDashboardAuth,
  session: DashboardSession,
  request: unknown,
  response: unknown,
  now: number = Date.now(),
): Promise<boolean> {
  if (now - session.iat <= auth.ttlMs / 2) return true;
  const user: DashboardSessionUser = {
    id: session.sub,
    ...(session.name !== undefined ? { name: session.name } : {}),
    roles: session.roles,
  };
  if (auth.revalidate) {
    let allowed: boolean;
    try {
      allowed = await auth.revalidate(user);
    } catch {
      // Fail closed: a throwing hook revokes rather than silently extending the session.
      allowed = false;
    }
    if (!allowed) {
      clearSessionCookie({ request, response });
      return false;
    }
  }
  issueSessionCookie(user, { auth, request, response, now });
  return true;
}
