function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface RawCookieResponse {
  getHeader(name: string): number | string | string[] | undefined;
  setHeader(name: string, value: string | string[]): unknown;
}

function isRawCookieResponse(value: unknown): value is RawCookieResponse {
  return (
    isRecord(value) &&
    typeof value.getHeader === 'function' &&
    typeof value.setHeader === 'function'
  );
}

/**
 * Resolve the writable Node `ServerResponse` from a platform response. Express' response IS the
 * Node response; Fastify's reply wraps it on `.raw`. Returns the outer response when it already
 * exposes get/setHeader (Express), otherwise the unwrapped `.raw` (Fastify) — so a single write
 * path serves both without a platform-specific dependency.
 */
function resolveCookieResponse(response: unknown): RawCookieResponse | null {
  if (isRawCookieResponse(response)) return response;
  if (isRecord(response) && isRawCookieResponse(response.raw)) return response.raw;
  return null;
}

function existingSetCookies(response: RawCookieResponse): string[] {
  const current = response.getHeader('set-cookie');
  if (Array.isArray(current)) return current;
  if (typeof current === 'string') return [current];
  return [];
}

/**
 * Append a `Set-Cookie` header to the response WITHOUT clobbering any cookies already queued by
 * the host. Platform-agnostic raw write — no-ops gracefully if the response can't be unwrapped.
 */
export function appendSetCookie(response: unknown, cookie: string): void {
  const raw = resolveCookieResponse(response);
  if (!raw) return;
  raw.setHeader('set-cookie', [...existingSetCookies(raw), cookie]);
}

interface RawRedirectResponse extends RawCookieResponse {
  statusCode: number;
  end(chunk?: string): unknown;
}

function isRawRedirectResponse(value: unknown): value is RawRedirectResponse {
  return (
    isRecord(value) &&
    typeof value.getHeader === 'function' &&
    typeof value.setHeader === 'function' &&
    typeof value.end === 'function'
  );
}

function resolveRedirectResponse(response: unknown): RawRedirectResponse | null {
  if (isRawRedirectResponse(response)) return response;
  if (isRecord(response) && isRawRedirectResponse(response.raw)) return response.raw;
  return null;
}

/**
 * Write a redirect directly on the raw response and END it. Used from the `DashboardLoginRedirect`
 * exception filter (guards can't use `@Redirect()` — that decorator only applies to a controller
 * handler's return value) and by the manual, non-passthrough logout handler. Bypassing Nest's
 * normal "send the handler's return value" pipeline this way is only safe when NOTHING downstream
 * (a filter, or Nest itself) will also try to write to the same response — both call sites here
 * are the terminal step of their request (an exception filter, or a `@Res()` non-passthrough
 * handler), so there is no second writer to race.
 */
export function redirectRaw(response: unknown, location: string, status = 302): void {
  const raw = resolveRedirectResponse(response);
  if (!raw) return;
  raw.statusCode = status;
  raw.setHeader('location', location);
  raw.end();
}

/**
 * Did something already write to this response?
 *
 * Used to decide whether a host's `unauthenticatedPage` hook actually produced a page. A hook that
 * returns without writing (an early `return`, a forgotten `await`, a template that resolved to
 * nothing) would otherwise leave the request hanging forever — the browser spins until it times
 * out, with no error anywhere. Checking this lets the caller fall back to the built-in page.
 *
 * Reads the Node `ServerResponse.headersSent` through the same Express/Fastify unwrapping as the
 * writers above; Fastify's own `reply.sent` is not consulted because `.raw.headersSent` is true in
 * every case that matters here (the reply has been flushed to the socket).
 */
export function responseAlreadyWritten(response: unknown): boolean {
  const raw = resolveRedirectResponse(response) as
    | (RawRedirectResponse & { headersSent?: boolean })
    | null;
  return raw?.headersSent === true;
}

/**
 * Write a full HTML page directly on the raw response and END it. Used by
 * `DashboardSessionRequiredFilter` (the Mode-A-only instruction page a guard renders in place of a
 * login redirect that no longer exists) — same raw-response bypass, and the same reason it's safe:
 * an exception filter is the terminal step of the request, so there's no second writer to race.
 */
export function writeHtmlRaw(response: unknown, html: string, status = 200): void {
  const raw = resolveRedirectResponse(response);
  if (!raw) return;
  raw.statusCode = status;
  raw.setHeader('content-type', 'text/html; charset=utf-8');
  // Same as the auth controller's `@Header('Cache-Control', ...)` on the sibling login page: this
  // page reflects live session state, so it must never be served stale from a cache.
  raw.setHeader('cache-control', 'no-store, must-revalidate');
  raw.end(html);
}
