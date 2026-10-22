import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import { setRawHeader, writeNotModifiedRaw } from './auth/response.js';

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
