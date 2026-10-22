import { timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type Provider,
  UnauthorizedException,
} from '@nestjs/common';
import { DASHBOARD_AUTH, type ResolvedDashboardAuth } from './auth/dashboard-auth-config.js';

/** The env var the token gate reads when no `token` option is given. */
export const DURABLE_DASHBOARD_TOKEN_ENV = 'DURABLE_DASHBOARD_TOKEN';

/** DI token carrying the resolved {@link DashboardGate} (one per dashboard mount). */
export const DASHBOARD_GATE = Symbol('DASHBOARD_GATE');

/**
 * What the module knows about how the console is protected, captured at `forRoot`/`forRootAsync`
 * time. Everything that can change between module definition and boot (env vars, the async
 * `dashboardAuth` factory) is read later, in {@link resolveDashboardGate}.
 */
export interface DashboardGateOptions {
  /** Host `guards` were passed (non-empty). */
  hasGuards: boolean;
  /** `allowUnauthenticated` as passed. */
  allowUnauthenticated?: boolean;
  /** `token` as passed (else `DURABLE_DASHBOARD_TOKEN` is read at boot). */
  token?: string;
}

/**
 * How the gate treats every console request:
 *
 * - `delegated`: `guards` or `dashboardAuth` protect the console; the gate passes everything.
 * - `open`: `allowUnauthenticated: true`; the gate passes everything (warned at boot).
 * - `token`: a request must carry the token (`Authorization: Bearer`, `x-durable-token`, or
 *   `?token=` on GET/HEAD).
 * - `unconfigured`: nothing was configured outside production; the gate passes everything
 *   (warned at boot, because production will deny).
 * - `deny`: nothing was configured and `NODE_ENV=production`; every request is refused.
 */
export type DashboardGateMode = 'delegated' | 'open' | 'token' | 'unconfigured' | 'deny';

export interface DashboardGate {
  mode: DashboardGateMode;
  /** Set only when `mode === 'token'`. */
  token?: string;
}

const LOG_CONTEXT = 'DurableDashboard';

const HOW_TO_CONFIGURE = [
  'Configure one of: `guards: [YourAuthGuard]`, `dashboardAuth: { secret, session | login }`',
  '(or `useDashboardAuth` in forRootAsync), a bearer token via the `token` option or the',
  `${DURABLE_DASHBOARD_TOKEN_ENV} env var, or \`allowUnauthenticated: true\` when the console is`,
  'already protected outside this module (a global guard, a reverse proxy, a private network).',
].join(' ');

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

/**
 * Decide the gate mode. Precedence: `guards`/`dashboardAuth` (they are the gate) > a token > the
 * `allowUnauthenticated` opt-out > the environment default. A token beats `allowUnauthenticated`
 * because a configured secret is never silently ignored.
 */
export function resolveDashboardGate(
  options: DashboardGateOptions,
  auth: ResolvedDashboardAuth | null,
): DashboardGate {
  if (options.hasGuards || auth !== null) return { mode: 'delegated' };
  const token = options.token ?? process.env[DURABLE_DASHBOARD_TOKEN_ENV];
  if (typeof token === 'string' && token !== '') return { mode: 'token', token };
  if (options.allowUnauthenticated === true) return { mode: 'open' };
  return { mode: isProduction() ? 'deny' : 'unconfigured' };
}

/** Log the one boot line the resolved gate calls for (nothing for a properly configured console). */
export function reportDashboardGate(
  gate: DashboardGate,
  options: DashboardGateOptions,
  logger: Pick<Logger, 'warn' | 'error'> = new Logger(LOG_CONTEXT),
): void {
  switch (gate.mode) {
    case 'open':
      logger.warn(
        'allowUnauthenticated: true. The durable console (including retry/cancel and other ' +
          'mutating endpoints) is served with NO authentication from this module. Only do this ' +
          'when a global guard or reverse proxy already protects it.',
      );
      return;
    case 'token':
      if (options.allowUnauthenticated === true) {
        logger.warn(
          'allowUnauthenticated: true is ignored because a dashboard token is configured; ' +
            'requests must carry the token.',
        );
      }
      return;
    case 'unconfigured':
      logger.warn(
        [
          'The durable console is UNAUTHENTICATED: no guards, dashboardAuth, token or',
          'allowUnauthenticated were configured. It is served open because NODE_ENV is not',
          '"production", but it WILL deny every request when NODE_ENV=production.',
          HOW_TO_CONFIGURE,
        ].join(' '),
      );
      return;
    case 'deny':
      logger.error(
        [
          'The durable console has no authentication configured and NODE_ENV=production, so it',
          'is failing closed: every console request (UI and API) is denied.',
          HOW_TO_CONFIGURE,
        ].join(' '),
      );
      return;
    case 'delegated':
      return;
  }
}

/** The `DASHBOARD_GATE` provider: resolves once, after `DASHBOARD_AUTH`, and logs once. */
export function dashboardGateProvider(options: DashboardGateOptions): Provider {
  return {
    provide: DASHBOARD_GATE,
    inject: [DASHBOARD_AUTH],
    useFactory: (auth: ResolvedDashboardAuth | null): DashboardGate => {
      const gate = resolveDashboardGate(options, auth);
      reportDashboardGate(gate, options);
      return gate;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function headerValue(request: Record<string, unknown>, name: string): string | undefined {
  const headers = request.headers;
  if (!isRecord(headers)) return undefined;
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

/**
 * Read the token from `Authorization: Bearer <token>`, `x-durable-token`, or (GET/HEAD only) a
 * `token` query param. The query channel is read-only on purpose: a `?token=` URL ends up in access
 * logs, `Referer` headers and browser history, and must never authorize a mutation.
 */
export function readDashboardToken(request: unknown): string | undefined {
  if (!isRecord(request)) return undefined;
  const authorization = headerValue(request, 'authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    if (match?.[1]) return match[1].trim();
  }
  const header = headerValue(request, 'x-durable-token');
  if (header) return header.trim();
  const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
  if (method === 'GET' || method === 'HEAD') {
    const query = request.query;
    if (isRecord(query)) {
      const value = query.token;
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return undefined;
}

/** Constant-time compare (a length mismatch returns `false` without calling `timingSafeEqual`). */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The fail-closed default gate, stamped on `DurableUiController` and `DurableApiController` (after
 * the built-in session guard, before host `guards`) whenever the module can't prove at definition
 * time that something else protects the console. It never gates `DurableAuthController`, so the
 * login/session/logout routes stay reachable. See {@link DashboardGateMode} for what each mode does.
 */
@Injectable()
export class DurableDashboardGateGuard implements CanActivate {
  constructor(@Inject(DASHBOARD_GATE) private readonly gate: DashboardGate) {}

  canActivate(context: ExecutionContext): boolean {
    switch (this.gate.mode) {
      case 'delegated':
      case 'open':
      case 'unconfigured':
        return true;
      case 'deny':
        throw new ForbiddenException(
          [
            'Durable dashboard authentication is not configured, and NODE_ENV=production denies',
            'an unauthenticated console.',
            HOW_TO_CONFIGURE,
          ].join(' '),
        );
      case 'token': {
        const provided = readDashboardToken(context.switchToHttp().getRequest<unknown>());
        if (provided !== undefined && secretsMatch(provided, this.gate.token ?? '')) return true;
        throw new UnauthorizedException(
          'A valid durable dashboard token is required (Authorization: Bearer <token>, ' +
            'x-durable-token, or ?token= on GET).',
        );
      }
    }
  }
}
