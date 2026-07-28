import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Inject, Logger, Optional } from '@nestjs/common';
import { DASHBOARD_AUTH, type ResolvedDashboardAuth } from './dashboard-auth-config.js';
import { renderSessionRequiredPage } from './login-page.js';
import { responseAlreadyWritten, writeHtmlRaw } from './response.js';

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

/**
 * Renders the Mode-A page for a denied navigation: the host's own `unauthenticatedPage` when one is
 * configured, otherwise the built-in instruction card.
 *
 * `@Optional()` on the injection is load-bearing. This filter is decorated onto
 * `DurableUiController` unconditionally (see that controller's docblock — it is inert when
 * `dashboardAuth` is absent, because the guard that throws its exception is only stamped on when
 * auth IS configured), so it must still construct in a module where `DASHBOARD_AUTH` was never
 * provided.
 */
@Catch(DashboardSessionRequiredException)
export class DashboardSessionRequiredFilter implements ExceptionFilter {
  private readonly logger = new Logger(DashboardSessionRequiredFilter.name);
  private warned = false;

  constructor(
    @Optional()
    @Inject(DASHBOARD_AUTH)
    private readonly auth: ResolvedDashboardAuth | null = null,
  ) {}

  async catch(exception: DashboardSessionRequiredException, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const response = http.getResponse();
    const hook = this.auth?.unauthenticatedPage;

    if (hook) {
      try {
        await hook({ request: http.getRequest(), response, basePath: exception.basePath });
        // The hook owns the response; if it wrote one, we are done.
        if (responseAlreadyWritten(response)) return;
        // It did not write. Falling through to the built-in page is the only outcome that neither
        // hangs the request forever nor invents a page the host did not ask for — but it is almost
        // certainly a bug in the hook, so say so.
        this.warnOnce(
          'dashboardAuth.unauthenticatedPage returned without writing a response; falling back to ' +
            'the built-in page. The hook must write AND end the response it is given.',
        );
      } catch (error) {
        // A broken host page must not turn a denial into a 500, and must never open the console.
        this.warnOnce(
          `dashboardAuth.unauthenticatedPage threw; falling back to the built-in page. ${String(error)}`,
        );
        // It may have written headers before throwing, in which case there is nothing left to do:
        // writing again would raise ERR_HTTP_HEADERS_SENT on top of the original failure.
        if (responseAlreadyWritten(response)) return;
      }
    }

    writeHtmlRaw(response, renderSessionRequiredPage(exception.basePath), HttpStatus.UNAUTHORIZED);
  }

  /** Once per process, not once per request: a broken hook fires on every denied navigation. */
  private warnOnce(message: string): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(message);
  }
}
