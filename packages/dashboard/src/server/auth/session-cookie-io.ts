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
 * In-flight `revalidate` calls, keyed by `<secret>:<sub>` (the secret disambiguates two
 * `dashboardAuth` configs that happen to share a process, e.g. tests) — joined, not repeated, by
 * every concurrent renewal of the SAME session. Entries are removed the moment their call settles
 * (`finally`, below), so this only ever holds calls genuinely in flight right now: it can't grow
 * without bound, and a throwing hook can't wedge a session's future renewals.
 */
const inFlightRevalidations = new Map<string, Promise<boolean>>();

/**
 * Run `auth.revalidate` for `user`, joining an already-in-flight call for the same session instead
 * of starting a second one. This is what makes the `RevalidateHook` doc's "runs at most once per
 * `ttl/2` per session" true under real traffic: a single console page load fires several parallel
 * API calls, and without this every one of them carrying the same past-half-life cookie would
 * independently call the host's hook before the first renewal's fresh cookie lands. Every caller
 * still awaits the SAME outcome and applies it to its OWN request/response — only the host round
 * trip is shared.
 */
function revalidateOnce(auth: ResolvedDashboardAuth, user: DashboardSessionUser): Promise<boolean> {
  const revalidate = auth.revalidate;
  if (!revalidate) return Promise.resolve(true);
  const key = `${auth.secret}:${user.id}`;
  const inFlight = inFlightRevalidations.get(key);
  if (inFlight) return inFlight;
  const call = Promise.resolve()
    .then(() => revalidate(user))
    // Fail closed: a throwing hook revokes rather than silently extending the session.
    .catch(() => false)
    .finally(() => {
      // Cleared on BOTH outcomes (the `.catch` above means this only ever sees a resolution, never
      // a rejection) so a later, non-concurrent renewal cycle calls the hook fresh rather than
      // reusing a stale result — and so the map never accumulates settled entries.
      inFlightRevalidations.delete(key);
    });
  inFlightRevalidations.set(key, call);
  return call;
}

/**
 * Sliding renewal + revalidation. When a valid cookie is past 50% of its TTL, re-issue a fresh one
 * so an active session never expires mid-use — but first give the host's `revalidate` hook a say,
 * so a deactivated or demoted user loses access instead of riding a self-renewing cookie forever.
 * Concurrent renewals of the same session share one `revalidate` call (see `revalidateOnce`).
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
  const allowed = await revalidateOnce(auth, user);
  if (!allowed) {
    clearSessionCookie({ request, response });
    return false;
  }
  issueSessionCookie(user, { auth, request, response, now });
  return true;
}
