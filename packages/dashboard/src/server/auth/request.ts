function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readHeaders(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) return {};
  const headers = request.headers;
  return isRecord(headers) ? headers : {};
}

/** Coerce a single header (string or string[]) to a string, else undefined. */
function headerToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(',');
  }
  return undefined;
}

/** Read the raw `Cookie` request header (Express and Fastify both expose `headers`). */
export function readCookieHeader(request: unknown): string | undefined {
  return headerToString(readHeaders(request).cookie);
}

/**
 * Decide whether the cookie should carry `Secure`. True when the request is https directly
 * (`request.protocol === 'https'`) OR a proxy forwarded https (`x-forwarded-proto` includes
 * 'https'). Defensive structural reads — never throws, defaults to insecure (works on plain http
 * in dev).
 */
export function isHttpsRequest(request: unknown): boolean {
  if (isRecord(request) && request.protocol === 'https') return true;
  const forwarded = headerToString(readHeaders(request)['x-forwarded-proto']);
  if (forwarded === undefined) return false;
  return forwarded
    .split(',')
    .map((proto) => proto.trim().toLowerCase())
    .includes('https');
}

/** The path + query a browser navigated to (Express's `originalUrl`, else the generic `url`). */
export function originalRequestUrl(request: unknown): string {
  if (!isRecord(request)) return '/';
  if (typeof request.originalUrl === 'string' && request.originalUrl !== '') {
    return request.originalUrl;
  }
  if (typeof request.url === 'string' && request.url !== '') return request.url;
  return '/';
}

/**
 * Guard a client-supplied redirect target against an open redirect: it must be a same-origin,
 * root-relative path (`/durable/foo`), never a protocol-relative (`//evil.com`) or absolute
 * (`https://evil.com`) URL. Falls back to `fallback` (typically the dashboard's own `basePath`)
 * for anything else, including a missing/non-string value.
 */
export function sanitizeReturnTo(candidate: unknown, fallback: string): string {
  if (typeof candidate !== 'string') return fallback;
  if (!candidate.startsWith('/')) return fallback;
  if (candidate.startsWith('//')) return fallback;
  if (candidate.includes('://')) return fallback;
  return candidate;
}
