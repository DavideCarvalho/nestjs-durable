import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { DASHBOARD_AUTH, type ResolvedDashboardAuth } from './auth/dashboard-auth-config.js';
import { renderLoginPage } from './auth/login-page.js';
import { sanitizeReturnTo } from './auth/request.js';
import { redirectRaw } from './auth/response.js';
import { clearSessionCookie, issueSessionCookie } from './auth/session-cookie-io.js';
import type { DashboardSessionUser } from './auth/session-cookie.js';
import { DASHBOARD_BASE_PATH } from './durable-ui.controller.js';

interface LoginBody {
  username?: unknown;
  password?: unknown;
  returnTo?: unknown;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Mints/clears the `dashboardAuth` session cookie and serves the built-in login page. Mounted
 * under `basePath` alongside `DurableUiController` (see `DurableDashboardModule.forRoot`), but on
 * a SEPARATE controller so it is never itself behind `DurableUiSessionGuard` — these endpoints
 * CREATE the session that guard checks for. `@Optional()` on both injections: this controller is
 * only registered when `dashboardAuth` might be configured (a static `forRoot({ dashboardAuth })`
 * or any `forRootAsync`), but the resolved value can still be `null` at runtime for the async case
 * — every handler below re-checks it and 404s rather than assuming it is set.
 */
@Controller()
export class DurableAuthController {
  private readonly logger = new Logger(DurableAuthController.name);
  /** Warn once per hook kind so a throwing hook doesn't spam logs on every failed attempt. */
  private readonly warnedHooks = new Set<string>();

  constructor(
    @Optional() @Inject(DASHBOARD_AUTH) private readonly auth: ResolvedDashboardAuth | null,
    @Inject(DASHBOARD_BASE_PATH) private readonly basePath: string,
  ) {}

  // The login page reads `returnTo`/`error` from `location.search` client-side (see
  // `login-page.ts`), so this response never varies per request and needs no templating beyond
  // the developer-controlled `basePath`.
  @Get('login')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, must-revalidate')
  loginPage(): string {
    const auth = this.requireAuth();
    if (!auth.login) throw new NotFoundException();
    return renderLoginPage(this.basePath);
  }

  // Called by the login page's own fetch (JSON, not a classic form POST — see `login-page.ts` for
  // why: it keeps the login page working with no host-configured body parser beyond the
  // JSON one Nest wires in by default on both Express and Fastify). Uniform `401` on any failure
  // (unknown user, wrong password, throwing hook) — no user-enumeration.
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginBody,
    @Req() request: unknown,
    @Res({ passthrough: true }) response: unknown,
  ): Promise<{ redirectTo: string }> {
    const auth = this.requireAuth();
    if (!auth.login) throw new NotFoundException();
    if (!isString(body?.username) || !isString(body?.password)) {
      throw new BadRequestException('Body must include string `username` and `password`.');
    }
    const { username, password } = body;
    const user = await this.runHook('login', () => auth.login?.(username, password) ?? null);
    if (!user) throw new UnauthorizedException({ message: 'Invalid username or password.' });
    issueSessionCookie(user, { auth, request, response });
    return { redirectTo: sanitizeReturnTo(body.returnTo, this.basePath) };
  }

  // Mode A: the host frontend (carrying its own auth) POSTs here; the host hook validates the raw
  // request and returns the session user, or `null` to deny. This is the SSO path — the host's own
  // guard decides, and no credential ever reaches this library.
  @Post('session')
  @HttpCode(204)
  async session(
    @Req() request: unknown,
    @Res({ passthrough: true }) response: unknown,
  ): Promise<void> {
    const auth = this.requireAuth();
    // Mode A not configured => the endpoint does not exist for this host.
    if (!auth.session) throw new NotFoundException();
    const user = await this.runHook('session', () => auth.session?.(request) ?? null);
    if (!user) throw new UnauthorizedException();
    issueSessionCookie(user, { auth, request, response });
  }

  // Plain `GET` (not `POST`): logging out only ever destroys the CALLER's own session, so it's
  // safe/idempotent from the caller's perspective — a simple `<a href>` (no JS, no CSRF token)
  // works. Non-passthrough `@Res()`: this handler owns the response outright (clears the cookie,
  // then redirects), so Nest must not also try to send a return value afterwards.
  @Get('logout')
  logout(@Req() request: unknown, @Res() response: unknown): void {
    // Best-effort: even without dashboardAuth configured, clearing is harmless.
    clearSessionCookie({ request, response });
    // Only bounce to the login page when Mode B is actually configured — under Mode A (only), that
    // page 404s (see loginPage()); redirecting to basePath instead lands back on the guarded UI,
    // which renders the Mode-A session-required instruction page.
    redirectRaw(response, this.auth?.login ? `${this.basePath}/login` : this.basePath);
  }

  private requireAuth(): ResolvedDashboardAuth {
    // login()/session()/logout() only reach a real request when dashboardAuth is configured — this
    // is a defensive guard (matching loginPage()'s 404), not a reachable runtime path in practice.
    if (!this.auth) throw new NotFoundException();
    return this.auth;
  }

  /**
   * Run a host hook (`login` or `session`) defensively: a throw is treated as a denial (uniform
   * failure) and warn-logged once PER KIND, so a buggy hook never 500s the endpoint into a
   * stack-trace leak nor floods the logs on repeated bad attempts.
   */
  private async runHook(
    kind: string,
    run: () => Promise<DashboardSessionUser | null> | DashboardSessionUser | null,
  ): Promise<DashboardSessionUser | null> {
    try {
      return (await run()) ?? null;
    } catch (error) {
      if (!this.warnedHooks.has(kind)) {
        this.warnedHooks.add(kind);
        this.logger.warn(
          `dashboardAuth ${kind} hook threw; treating as denial. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
}
