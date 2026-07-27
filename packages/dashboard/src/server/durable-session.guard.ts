import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { DASHBOARD_AUTH, type ResolvedDashboardAuth } from './auth/dashboard-auth-config.js';
import { DashboardLoginRedirectException } from './auth/login-redirect.exception.js';
import { originalRequestUrl } from './auth/request.js';
import { maybeRenewSession, readSessionFromRequest } from './auth/session-cookie-io.js';
import { DashboardSessionRequiredException } from './auth/session-required.exception.js';
import { DASHBOARD_BASE_PATH } from './durable-ui.controller.js';

/**
 * Gates `DurableUiController` (the SPA shell + assets, a full-page browser navigation) on a valid
 * `dashboardAuth` session cookie. A no-op (always `true`) when `dashboardAuth` was not configured
 * — see `DurableDashboardModule.forRoot`'s `dashboardAuth` doc. Missing/invalid/expired session,
 * when Mode B (`login`) is configured, gets a `302` to the built-in login page carrying
 * `?returnTo=<original url>`, via `DashboardLoginRedirectException` (see that file for why a guard
 * can't just call `response.redirect()` and return `false`). When only Mode A (`session`) is
 * configured there is no login page to redirect to — the host mints the session itself — so it
 * instead throws `DashboardSessionRequiredException`, rendering a small instruction page.
 *
 * Auth is mount-level and role-agnostic: this guard has no notion of control-plane vs tenant
 * (see the durable dashboard's topology note in `dashboard.service.ts`) — it only ever answers
 * "is there a valid dashboard session", nothing role-specific changes here.
 */
@Injectable()
export class DurableUiSessionGuard implements CanActivate {
  constructor(
    @Inject(DASHBOARD_AUTH) private readonly auth: ResolvedDashboardAuth | null,
    @Inject(DASHBOARD_BASE_PATH) private readonly basePath: string,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.auth) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<unknown>();
    const session = readSessionFromRequest(this.auth, request);
    if (!session) {
      if (!this.auth.login) {
        // Mode A only: there is no login page to bounce to — the host mints the session. Serve the
        // instruction page instead of redirecting into a 404.
        throw new DashboardSessionRequiredException(this.basePath);
      }
      const returnTo = encodeURIComponent(originalRequestUrl(request));
      throw new DashboardLoginRedirectException(`${this.basePath}/login?returnTo=${returnTo}`);
    }
    maybeRenewSession(this.auth, session, request, http.getResponse());
    return true;
  }
}

/**
 * Gates `DurableApiController` (the JSON API the SPA fetches) on a valid `dashboardAuth` session
 * cookie. A no-op (always `true`) when `dashboardAuth` was not configured. Missing/invalid/expired
 * session => a plain `401` (the API is called via `fetch`, never a browser navigation, so a
 * redirect would just fail the request anyway — the caller reads the status code, not HTML).
 *
 * Mount-level and role-agnostic, same as `DurableUiSessionGuard` above.
 */
@Injectable()
export class DurableApiSessionGuard implements CanActivate {
  constructor(@Inject(DASHBOARD_AUTH) private readonly auth: ResolvedDashboardAuth | null) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.auth) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<unknown>();
    const session = readSessionFromRequest(this.auth, request);
    if (!session) throw new UnauthorizedException();
    maybeRenewSession(this.auth, session, request, http.getResponse());
    return true;
  }
}
