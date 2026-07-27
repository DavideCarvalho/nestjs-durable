import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import { renderSessionRequiredPage } from './login-page.js';
import { writeHtmlRaw } from './response.js';

/**
 * Thrown by `DurableUiSessionGuard` when a page-level (full-page navigation) request has no valid
 * `dashboardAuth` session AND Mode B (`login`) isn't configured — there is no login page to
 * redirect to (see `DashboardLoginRedirectException`, its Mode-B sibling). Carries `basePath` so
 * the filter below can render the Mode-A instruction page in its place. Same reasoning as the
 * login redirect for why a guard can't just write the response directly and return `false`: a
 * dedicated, controller-scoped `DashboardSessionRequiredFilter` (see below) is the only writer,
 * guaranteeing no double-write race.
 */
export class DashboardSessionRequiredException extends HttpException {
  constructor(public readonly basePath: string) {
    super({ basePath }, HttpStatus.UNAUTHORIZED);
  }
}

/** Turns a `DashboardSessionRequiredException` into the rendered Mode-A instruction page. */
@Catch(DashboardSessionRequiredException)
export class DashboardSessionRequiredFilter implements ExceptionFilter {
  catch(exception: DashboardSessionRequiredException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    writeHtmlRaw(response, renderSessionRequiredPage(exception.basePath), HttpStatus.UNAUTHORIZED);
  }
}
