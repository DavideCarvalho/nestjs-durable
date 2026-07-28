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

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.auth) return true;
    const auth = this.auth;
    const http = context.switchToHttp();
    const request = http.getRequest<unknown>();
    const session = readSessionFromRequest(auth, request);
    if (!session) {
      this.denyUnauthenticated(auth, request);
    }
    if (!(await maybeRenewSession(auth, session, request, http.getResponse()))) {
      this.denyUnauthenticated(auth, request);
    }
    return true;
  }

  /**
   * A revoked session (the host's `revalidate` hook says no) is denied exactly like an absent
   * one — by design, there is nothing left to distinguish "never had a session" from "had one,
   * then lost it" once the cookie is cleared, so both get the same Mode-aware treatment.
   *
   * Takes `auth` explicitly rather than reading `this.auth`: `canActivate`'s `!this.auth` early
   * return narrows the field within that method only — TS doesn't carry it across a method call
   * — so callers pass the already-narrowed value instead of this method re-deriving (or
   * asserting away) the nullability.
   */
  private denyUnauthenticated(auth: ResolvedDashboardAuth, request: unknown): never {
    if (!auth.modes.includes('login')) throw new DashboardSessionRequiredException(this.basePath);
    const returnTo = encodeURIComponent(originalRequestUrl(request));
    throw new DashboardLoginRedirectException(`${this.basePath}/login?returnTo=${returnTo}`);
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

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.auth) return true;
    const auth = this.auth;
    const http = context.switchToHttp();
    const request = http.getRequest<unknown>();
    const session = readSessionFromRequest(auth, request);
    if (!session) throw this.unauthorized(auth);
    if (!(await maybeRenewSession(auth, session, request, http.getResponse()))) {
      // Revoked mid-session: same treatment as an absent cookie.
      throw this.unauthorized(auth);
    }
    return true;
  }

  /**
   * A bare 401 body carrying `{ auth: { modes } }` — mirrors `@dudousxd/nestjs-telescope`'s
   * dashboardAuth 401. The API is fetched (never navigated), so this is the ONLY way the console
   * SPA (`durable-client.ts`) learns which auth surface to send the operator to on a mid-session
   * 401; `DurableUiSessionGuard`'s redirect/session-required exceptions above don't reach it.
   */
  private unauthorized(auth: ResolvedDashboardAuth): UnauthorizedException {
    return new UnauthorizedException({ auth: { modes: auth.modes } });
  }
}
