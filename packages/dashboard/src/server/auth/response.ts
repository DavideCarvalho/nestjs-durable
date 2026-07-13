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
  end(): unknown;
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
