import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';

interface RawResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(): unknown;
}

function isRawResponse(value: unknown): value is RawResponse {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.setHeader === 'function' && typeof candidate.end === 'function';
}

/**
 * The writable Node `ServerResponse` behind a platform response: Express' response IS it, Fastify's
 * reply wraps it on `.raw`. One write path serves both without a platform-specific dependency.
 */
function rawResponse(response: unknown): RawResponse | null {
  if (isRawResponse(response)) return response;
  const raw = (response as { raw?: unknown } | null)?.raw;
  return isRawResponse(raw) ? raw : null;
}

/** Set one header on the raw response (Express or Fastify). */
function setRawHeader(response: unknown, name: string, value: string): void {
  rawResponse(response)?.setHeader(name, value);
}

/**
 * Write a bodiless `304 Not Modified` carrying its validator, and END the response. Its only caller
 * is an exception filter, the terminal step of the request, so there is no second writer to race.
 */
function writeNotModifiedRaw(response: unknown, etag: string): void {
  const raw = rawResponse(response);
  if (!raw) return;
  raw.statusCode = 304;
  raw.setHeader('etag', etag);
  raw.setHeader('cache-control', 'private, no-cache');
  raw.end();
}

/**
 * How a detail endpoint answers a poll whose `If-None-Match` still names the current version.
 * Thrown rather than returned because Nest sets a handler's status after the handler returns; an
 * {@link NotModifiedFilter} writes the bodiless 304 itself.
 */
export class NotModifiedException extends HttpException {
  constructor(readonly etag: string) {
    super('Not Modified', 304);
  }
}

/** Writes a {@link NotModifiedException} as a bare 304, on Express and Fastify alike. */
@Catch(NotModifiedException)
export class NotModifiedFilter implements ExceptionFilter<NotModifiedException> {
  catch(exception: NotModifiedException, host: ArgumentsHost): void {
    writeNotModifiedRaw(host.switchToHttp().getResponse(), exception.etag);
  }
}

/**
 * Mark a response as revalidatable: `no-cache` makes the browser ask again on every poll, sending
 * the `ETag` back as `If-None-Match`, so an unchanged run costs a 304 instead of a body.
 */
export function setEtag(response: unknown, etag: string): void {
  setRawHeader(response, 'etag', etag);
  setRawHeader(response, 'cache-control', 'private, no-cache');
}
