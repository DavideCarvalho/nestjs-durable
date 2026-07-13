import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import { redirectRaw } from './response.js';

/**
 * Thrown by `DurableUiSessionGuard` when a page-level (full-page navigation) request has no valid
 * `dashboardAuth` session — carries the login URL to redirect to. Guards can't use Nest's
 * `@Redirect()` decorator (that only applies to a controller handler's return value), so the
 * guard throws this and a dedicated, controller-scoped `DashboardLoginRedirectFilter` (see below)
 * turns it into a real `302`. This is the ONLY safe way to redirect from a guard: writing directly
 * to the response inside `canActivate` and then returning `false` risks a double-write (Nest still
 * tries to send a `ForbiddenException` response afterwards) — routing through the normal
 * exception-filter pipeline instead guarantees exactly one writer finalizes the response.
 */
export class DashboardLoginRedirectException extends HttpException {
  constructor(public readonly location: string) {
    super({ location }, HttpStatus.FOUND);
  }
}

/** Turns a `DashboardLoginRedirectException` into a real `302 Location: <location>` response. */
@Catch(DashboardLoginRedirectException)
export class DashboardLoginRedirectFilter implements ExceptionFilter {
  catch(exception: DashboardLoginRedirectException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    redirectRaw(response, exception.location);
  }
}
