import 'reflect-metadata';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  type Type,
  UseFilters,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { HttpAdapterHost, type ModuleRef } from '@nestjs/core';

// ---------------------------------------------------------------------------------------------
// The console access contract. Every Aviary console declares these LOCALLY with identical names
// and shapes (no cross-lib import): TypeScript is structural, so one authorizer fits every console.
// ---------------------------------------------------------------------------------------------

export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** Class form: an `@Injectable()` provider (constructor injection works). */
export interface ConsoleAuthorizer {
  authorize(context: ExecutionContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}
export type ConsoleAuthorizerClass = Type<ConsoleAuthorizer>;

/** An `@nestjs/authorization` policy check: `policy[ability](user)`. */
export interface ConsolePolicyCheck {
  policy: Type<unknown>;
  ability: string;
}

export type ConsoleAuthorize =
  | ((context: ExecutionContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>)
  | ConsoleAuthorizerClass
  | (() => Promise<{ default: ConsoleAuthorizerClass }>)
  | ConsolePolicyCheck
  | string;

export type ConsoleDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/** What a resolved `authorize` is: called once per request, never throws. */
export type ConsoleDecide = (context: ExecutionContext) => Promise<ConsoleDecision>;

/**
 * The provider `@dudousxd/nestjs-authz` registers to resolve gate names (`authorize: 'console.x'`).
 * A registry symbol, so it is found without depending on that package.
 */
export const CONSOLE_GATE = Symbol.for('@dudousxd/aviary:console-gate');
export interface ConsoleGate {
  allows(name: string, context: ExecutionContext): Promise<ConsoleAuthorizeResult>;
}

const PACKAGE = '@dudousxd/nestjs-durable-dashboard';
const MODULE = 'DurableDashboardModule';

/** The one boot warning for a console with no `authorize`. Same wording in every Aviary console. */
export const CONSOLE_AUTHORIZE_MISSING_WARNING = `[${PACKAGE}] console has no \`authorize\` configured: it is open outside production and denies every request in production. Set \`authorize\` in ${MODULE}.forRoot().`;

// Factories, not shared constants: every decision is a fresh object, so a caller mutating one can
// never change the answer for the next request.
const allow = (): ConsoleDecision => ({ allowed: true });
const forbidden = (): ConsoleDecision => ({ allowed: false, reason: 'forbidden' });
const unauthenticated = (): ConsoleDecision => ({ allowed: false, reason: 'unauthenticated' });

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

/**
 * A class with `authorize()`: on the prototype, or (an instance-property arrow function,
 * `authorize = (ctx) => ...`) only on instances, so any `class`.
 */
function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  if (typeof value !== 'function') return false;
  if (
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  ) {
    return true;
  }
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

function isPolicyCheck(value: unknown): value is ConsolePolicyCheck {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ConsolePolicyCheck).policy === 'function' &&
    typeof (value as ConsolePolicyCheck).ability === 'string'
  );
}

function isLazyModule(value: unknown): value is { default: ConsoleAuthorizerClass } {
  return (
    typeof value === 'object' &&
    value !== null &&
    isAuthorizerClass((value as { default?: unknown }).default)
  );
}

/** Turns any {@link ConsoleAuthorizeResult} into a {@link ConsoleDecision}. */
export function normalizeConsoleResult(result: unknown): ConsoleDecision {
  if (result === true) return allow();
  if (typeof result !== 'object' || result === null) return forbidden();
  const shape = result as { allowed?: unknown; reason?: unknown; redirectTo?: unknown };
  if (typeof shape.redirectTo === 'string' && shape.allowed !== true) {
    return { allowed: false, reason: 'unauthenticated', redirectTo: shape.redirectTo };
  }
  if (shape.allowed === true) return allow();
  return shape.reason === 'unauthenticated' ? unauthenticated() : forbidden();
}

/** `null`, `undefined` and `false` mean "nobody signed in", like `@nestjs/authorization`'s guard. */
function hasUser(user: unknown): boolean {
  return user !== null && user !== undefined && user !== false;
}

async function policyDecider(
  check: ConsolePolicyCheck,
  moduleRef: ModuleRef,
): Promise<ConsoleDecide> {
  let pkg: typeof import('@nestjs/authorization');
  try {
    pkg = await import('@nestjs/authorization');
  } catch {
    throw new Error(
      `${MODULE}: \`authorize: { policy, ability }\` needs @nestjs/authorization installed, with AuthorizationModule.forRoot() imported in the app; or pass a function, a class, or a gate name.`,
    );
  }
  const { AuthorizationService, AUTHORIZATION_MODULE_OPTIONS, defaultGetUser } = pkg;
  try {
    moduleRef.get(AuthorizationService, { strict: false });
  } catch {
    throw new Error(
      `${MODULE}: \`authorize: { policy, ability }\` needs AuthorizationModule.forRoot() from @nestjs/authorization imported in the app.`,
    );
  }
  // The user the official `@Can()` sees: the module's `getUser` when one is configured, else the
  // package default (`request.user`). Exactly one of them answers; `undefined`, `null` and `false`
  // all mean a guest, as in `AuthorizationGuard`.
  let getUser = defaultGetUser as (context: ExecutionContext) => unknown;
  try {
    const options = moduleRef.get<{ getUser?: (context: ExecutionContext) => unknown }>(
      AUTHORIZATION_MODULE_OPTIONS,
      { strict: false },
    );
    if (typeof options?.getUser === 'function') getUser = options.getUser;
  } catch {
    // No options registered: the package default reads `request.user`.
  }
  return async (context) => {
    const authorization = moduleRef.get(AuthorizationService, { strict: false });
    const user = await getUser(context);
    const can = authorization.can as (
      policy: unknown,
      ability: string,
      user: unknown,
    ) => Promise<boolean>;
    if (await can.call(authorization, check.policy, check.ability, hasUser(user) ? user : null)) {
      return allow();
    }
    return hasUser(user) ? forbidden() : unauthenticated();
  };
}

function gateDecider(name: string, moduleRef: ModuleRef): ConsoleDecide {
  try {
    moduleRef.get(CONSOLE_GATE, { strict: false });
  } catch {
    throw new Error(
      `\`authorize: '${name}'\` needs @dudousxd/nestjs-authz's AuthzModule (it resolves gate names); or pass a function, a class, or { policy, ability }`,
    );
  }
  return async (context) => {
    const gate = moduleRef.get<ConsoleGate>(CONSOLE_GATE, { strict: false });
    return normalizeConsoleResult(await gate.allows(name, context));
  };
}

function classDecider(moduleRef: ModuleRef): (Class: ConsoleAuthorizerClass) => ConsoleDecide {
  const instances = new Map<ConsoleAuthorizerClass, Promise<ConsoleAuthorizer>>();
  const instanceOf = (Class: ConsoleAuthorizerClass): Promise<ConsoleAuthorizer> => {
    const cached = instances.get(Class);
    if (cached) return cached;
    const pending = (async (): Promise<ConsoleAuthorizer> => {
      try {
        // A registered provider is used as is; otherwise one instance per registration.
        const registered = moduleRef.get(Class, { strict: false });
        if (registered) return registered;
      } catch {
        // Not a provider: create it below.
      }
      return moduleRef.create(Class);
    })();
    // A failed construction is retried on the next request instead of denying forever.
    pending.catch(() => instances.delete(Class));
    instances.set(Class, pending);
    return pending;
  };
  return (Class) => async (context) =>
    normalizeConsoleResult(await (await instanceOf(Class)).authorize(context));
}

/**
 * Resolves `authorize` into one function the guard calls per request. Resolution errors that are
 * configuration mistakes (a gate name without nestjs-authz, a policy without @nestjs/authorization)
 * throw here, so call it at boot. The returned function never throws: an error is a `forbidden`.
 *
 * `authorize` omitted: open outside production, `forbidden` for every request in production (read
 * when this runs), and one warning logged (unless `warnIfMissing: false`).
 */
export async function resolveConsoleAuthorize(
  authorize: ConsoleAuthorize | undefined,
  moduleRef: ModuleRef,
  options: { logger?: Logger; warnIfMissing?: boolean } = {},
): Promise<ConsoleDecide> {
  const logger = options.logger ?? new Logger(MODULE);
  if (authorize === undefined) {
    if (options.warnIfMissing !== false) logger.warn(CONSOLE_AUTHORIZE_MISSING_WARNING);
    const production = isProduction();
    return async () => (production ? forbidden() : allow());
  }

  let decide: ConsoleDecide;
  if (typeof authorize === 'string') {
    decide = gateDecider(authorize, moduleRef);
  } else if (isPolicyCheck(authorize)) {
    decide = await policyDecider(authorize, moduleRef);
  } else if (isAuthorizerClass(authorize)) {
    decide = classDecider(moduleRef)(authorize);
  } else if (typeof authorize === 'function') {
    const fromClass = classDecider(moduleRef);
    let lazy: ConsoleDecide | undefined;
    const fn = authorize as (context: ExecutionContext) => unknown;
    decide = async (context) => {
      if (lazy) return lazy(context);
      const result = await fn(context);
      if (!isLazyModule(result)) return normalizeConsoleResult(result);
      // A lazy import: remember the class, so the import runs once per registration.
      lazy = fromClass(result.default);
      return lazy(context);
    };
  } else {
    throw new Error(
      `${MODULE}: \`authorize\` must be a function, a class with authorize(), a lazy import, { policy, ability } or a gate name.`,
    );
  }

  return async (context) => {
    try {
      return await decide(context);
    } catch (error) {
      logger.warn(
        `console \`authorize\` threw, denying the request: ${error instanceof Error ? error.message : String(error)}`,
      );
      return forbidden();
    }
  };
}

// ---------------------------------------------------------------------------------------------
// authorizeByToken
// ---------------------------------------------------------------------------------------------

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Allows a request carrying `Authorization: Bearer <token>` (compared timing-safe); anything else
 * is `unauthenticated`. Header only: no query string, no custom header. Throws when `token` is
 * empty, so a missing env var fails at config time instead of opening the console.
 */
export function authorizeByToken(options: { token: string | undefined }): ConsoleAuthorize {
  const token = options.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('authorizeByToken: `token` is empty; set it (e.g. from an env var).');
  }
  const expected = sha256(token);
  return (context: ExecutionContext): ConsoleAuthorizeResult => {
    const header = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>()
      ?.headers?.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (match?.[1] && timingSafeEqual(sha256(match[1]), expected)) return true;
    return { allowed: false, reason: 'unauthenticated' };
  };
}

// ---------------------------------------------------------------------------------------------
// Enforcement: a guard (decides) + a filter scoped to the console controllers (answers).
// ---------------------------------------------------------------------------------------------

/** DI token of the resolved {@link ConsoleDecide} the guard runs. */
export const CONSOLE_AUTHORIZE_DECIDE = Symbol(`${PACKAGE}:console-authorize`);

/** Marks a controller as serving pages: a denied `GET` that accepts HTML gets a page, not JSON. */
export const CONSOLE_PAGE_METADATA = `${PACKAGE}:console-page`;
export const ConsolePage = (): ClassDecorator => (target) => {
  Reflect.defineMetadata(CONSOLE_PAGE_METADATA, true, target);
};

/**
 * The denial the guard throws. An `HttpException` with the JSON body, so it still answers correctly
 * where {@link ConsoleAuthorizeFilter} is not applied; the filter adds the page answers.
 */
export class ConsoleAccessDenied extends HttpException {
  constructor(
    readonly decision: Extract<ConsoleDecision, { allowed: false }>,
    readonly page: boolean,
  ) {
    const unauthenticated = decision.reason === 'unauthenticated';
    super(
      unauthenticated
        ? {
            error: 'unauthenticated',
            ...(decision.redirectTo ? { redirectTo: decision.redirectTo } : {}),
          }
        : { error: 'forbidden' },
      unauthenticated ? 401 : 403,
    );
  }
}

/**
 * Marks a console route that is not part of the console: `authorize` does not apply to it. Used on
 * the `ctx.webhook()` callback, which third parties call with the token as the secret.
 */
export const CONSOLE_PUBLIC_METADATA = `${PACKAGE}:console-public`;
export const ConsolePublic = (): MethodDecorator => (_target, _key, descriptor) => {
  Reflect.defineMetadata(CONSOLE_PUBLIC_METADATA, true, descriptor.value as object);
};

@Injectable()
export class ConsoleAuthorizeGuard implements CanActivate {
  constructor(@Inject(CONSOLE_AUTHORIZE_DECIDE) private readonly decide: ConsoleDecide) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (Reflect.getMetadata(CONSOLE_PUBLIC_METADATA, context.getHandler()) === true) return true;
    const decision = await this.decide(context);
    if (decision.allowed) return true;
    throw new ConsoleAccessDenied(decision, isPageNavigation(context));
  }
}

function isPageNavigation(context: ExecutionContext): boolean {
  if (context.getType() !== 'http') return false;
  if (Reflect.getMetadata(CONSOLE_PAGE_METADATA, context.getClass()) !== true) return false;
  const request = context
    .switchToHttp()
    .getRequest<{ method?: string; headers?: Record<string, unknown> }>();
  const accept = request?.headers?.accept;
  return request?.method === 'GET' && typeof accept === 'string' && accept.includes('text/html');
}

/** The minimal page answered to a denied page navigation: same markup for 401 and 403. */
const consolePage = (title: string, message: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center"><h1>${title}</h1><p>${message}</p></main></body></html>`;
const DENIED_PAGE = consolePage('Access denied', 'You do not have access to this console.');
const SIGN_IN_PAGE = consolePage('Sign in required', 'Sign in to open this console.');

@Catch(ConsoleAccessDenied)
export class ConsoleAuthorizeFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: ConsoleAccessDenied, host: ArgumentsHost): void {
    const adapter = this.adapterHost.httpAdapter;
    const response = host.switchToHttp().getResponse();
    const { decision, page } = exception;
    if (page && decision.redirectTo) {
      adapter.redirect(response, 302, decision.redirectTo);
      return;
    }
    if (page) {
      const forbiddenPage = decision.reason === 'forbidden';
      adapter.setHeader(response, 'Content-Type', 'text/html; charset=utf-8');
      adapter.reply(
        response,
        forbiddenPage ? DENIED_PAGE : SIGN_IN_PAGE,
        forbiddenPage ? 403 : 401,
      );
      return;
    }
    adapter.reply(response, exception.getResponse(), exception.getStatus());
  }
}

/**
 * The guard and its filter as one class decorator, for a console you mount yourself
 * (`routes: false`). List it ABOVE your authentication guards, so it runs after them.
 */
export const UseConsoleAuthorize = (): ClassDecorator & MethodDecorator =>
  applyDecorators(UseGuards(ConsoleAuthorizeGuard), UseFilters(ConsoleAuthorizeFilter));
