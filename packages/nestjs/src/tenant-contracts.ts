import type {
  TenantTokenSource,
  TenantVerifier,
  VerifiedTenant,
} from '@dudousxd/nestjs-durable-core';
import type { ModuleRef } from '@nestjs/core';

/** What a tenant verifier receives for each request a tenant process sends. */
export interface TenantVerifierInput {
  /** The token presented on the request (the wire `tenant` field). */
  token?: string | undefined;
  /** The tenant the request *claims* to be. Advisory only: derive the real one from the token. */
  tenant?: string | undefined;
}

/**
 * The object/class form of `verifyTenant`. Runs on the control plane for every request a tenant
 * process sends.
 */
export interface TenantVerifierContract {
  /**
   * Turn the wire token into the tenant it authenticates as. Return `null` to reject: the request is
   * answered `unauthorized` and never touches a run. Throw when you cannot decide (the identity
   * provider is down): the request fails with the error and the next one calls `verify` again. The
   * returned `tenant` is trusted as-is, so derive it from the verified token, never from
   * `input.tenant`.
   */
  verify(input: TenantVerifierInput): VerifiedTenant | null | Promise<VerifiedTenant | null>;
}

/**
 * The object/class form of `tenantToken`. Runs on the tenant process before every request it sends.
 */
export interface TenantCredentialsContract {
  /**
   * The token to present on the next request, sent as-is in the wire `tenant` field. Called once per
   * request, so cache the token and fetch a new one before it expires. A throw (or an empty string)
   * fails that request; the next request calls `token()` again.
   */
  token(): string | Promise<string>;
}

/** A class implementing a contract; its constructor parameters are resolved by Nest DI. */
export type ContractClass<T> = new (...args: any[]) => T;

/** A lazy import of a module whose default export is a contract class or object. */
export type LazyContract<T> = () => Promise<{ default: ContractClass<T> | T }>;

/**
 * The `verifyTenant` option: a function (e.g. `hmacTenantVerifier(secret)`), an object implementing
 * {@link TenantVerifierContract}, a class implementing it (built once through Nest DI: the registered
 * provider when there is one, else `ModuleRef.create`), or a lazy import of a module whose default
 * export is such a class or object (imported once).
 */
export type TenantVerifierOption =
  | TenantVerifier
  | TenantVerifierContract
  | ContractClass<TenantVerifierContract>
  | LazyContract<TenantVerifierContract>;

/**
 * The `tenantToken` option: a string, a function called before every request, an object implementing
 * {@link TenantCredentialsContract}, a class implementing it (built once through Nest DI), or a lazy
 * import of a module whose default export is such a class or object (imported once).
 */
export type TenantTokenOption =
  | TenantTokenSource
  | TenantCredentialsContract
  | ContractClass<TenantCredentialsContract>
  | LazyContract<TenantCredentialsContract>;

/** Marks a function this module already resolved, so resolving it again returns it unchanged. */
const RESOLVED = Symbol('nestjs-durable:resolved-tenant-auth');

function markResolved<F extends object>(fn: F): F {
  Object.defineProperty(fn, RESOLVED, { value: true });
  return fn;
}

function isResolved(value: unknown): boolean {
  return typeof value === 'function' && (value as { [RESOLVED]?: true })[RESOLVED] === true;
}

/** Any `class`, or a function whose prototype carries `method` (a transpiled class). */
function isClass(value: unknown, method: string): value is ContractClass<unknown> {
  if (typeof value !== 'function') return false;
  const proto = (value as { prototype?: Record<string, unknown> }).prototype;
  if (typeof proto?.[method] === 'function') return true;
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

function hasMethod<T>(value: unknown, method: string): value is T {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[method] === 'function'
  );
}

/** A module object returned by a lazy `import()`: its `default` is a contract class or object. */
function lazyDefault(value: unknown, method: string): unknown {
  if (typeof value !== 'object' || value === null || !('default' in value)) return undefined;
  const target = (value as { default: unknown }).default;
  return isClass(target, method) || hasMethod(target, method) ? target : undefined;
}

/**
 * Builds a contract class once: the registered provider when the app registers it, else a fresh
 * instance through `ModuleRef.create` (so constructor injection works). Without a `ModuleRef` it is
 * constructed with `new`. A failed construction is retried on the next call.
 */
function instanceFactory<T>(
  Class: ContractClass<T>,
  moduleRef: ModuleRef | undefined,
): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= (async (): Promise<T> => {
      if (!moduleRef) return new Class();
      try {
        const registered = moduleRef.get<T>(Class, { strict: false });
        if (registered) return registered;
      } catch {
        // Not a registered provider: create it below.
      }
      try {
        return await moduleRef.create<T>(Class);
      } catch (cause) {
        throw new Error(
          `could not build ${Class.name || 'the tenant auth class'}: register it as a provider in your module, or make its dependencies global`,
          { cause },
        );
      }
    })();
    pending.catch(() => {
      pending = undefined;
    });
    return pending;
  };
}

/** Resolves a contract target (class or object) to a getter of its instance. */
function contractInstance<T>(
  target: unknown,
  method: string,
  moduleRef: ModuleRef | undefined,
): () => Promise<T> {
  if (isClass(target, method)) return instanceFactory(target as ContractClass<T>, moduleRef);
  const instance = Promise.resolve(target as T);
  return () => instance;
}

/**
 * One instance getter per lazily imported export, so calls racing on the first import still share
 * one instance.
 */
function lazyInstances<T>(
  method: string,
  moduleRef: ModuleRef | undefined,
): (target: unknown) => () => Promise<T> {
  const getters = new Map<unknown, () => Promise<T>>();
  return (target) => {
    let getter = getters.get(target);
    if (!getter) {
      getter = contractInstance<T>(target, method, moduleRef);
      getters.set(target, getter);
    }
    return getter;
  };
}

/**
 * Turns any {@link TenantVerifierOption} into the plain {@link TenantVerifier} the engine and the
 * responder call. A class is built once, on the first request; a lazy import runs once.
 */
export function resolveTenantVerifier(
  option: TenantVerifierOption | undefined,
  moduleRef?: ModuleRef,
): TenantVerifier | undefined {
  if (option === undefined || isResolved(option)) return option as TenantVerifier | undefined;
  let instance: (() => Promise<TenantVerifierContract>) | undefined;
  if (isClass(option, 'verify') || hasMethod<TenantVerifierContract>(option, 'verify')) {
    instance = contractInstance(option, 'verify', moduleRef);
  } else if (typeof option !== 'function') {
    throw new Error(
      '`verifyTenant` must be a function, an object or class with verify(), or a lazy import of one.',
    );
  }
  const fn = option as (input: TenantVerifierInput) => unknown;
  const fromModule = lazyInstances<TenantVerifierContract>('verify', moduleRef);
  let lazy: (() => Promise<TenantVerifierContract>) | undefined;
  return markResolved(async (input: TenantVerifierInput): Promise<VerifiedTenant | null> => {
    const getter = instance ?? lazy;
    if (getter) return (await getter()).verify(input);
    const result = await fn(input);
    const target = lazyDefault(result, 'verify');
    if (target === undefined) return result as VerifiedTenant | null;
    // A lazy import: remember the module's export, so the import runs once per registration.
    lazy = fromModule(target);
    return (await lazy()).verify(input);
  });
}

function requireToken(token: unknown): string {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('tenantToken produced no token (an empty or non-string value)');
  }
  return token;
}

/**
 * Turns any {@link TenantTokenOption} into the {@link TenantTokenSource} the wire layer uses: a
 * static string stays a string, every other form becomes a function called before each request.
 */
export function resolveTenantTokenSource(
  option: TenantTokenOption | undefined,
  moduleRef?: ModuleRef,
): TenantTokenSource | undefined {
  if (option === undefined || typeof option === 'string' || isResolved(option)) {
    return option as TenantTokenSource | undefined;
  }
  let instance: (() => Promise<TenantCredentialsContract>) | undefined;
  if (isClass(option, 'token') || hasMethod<TenantCredentialsContract>(option, 'token')) {
    instance = contractInstance(option, 'token', moduleRef);
  } else if (typeof option !== 'function') {
    throw new Error(
      '`tenantToken` must be a string, a function, an object or class with token(), or a lazy import of one.',
    );
  }
  const fn = option as () => unknown;
  const fromModule = lazyInstances<TenantCredentialsContract>('token', moduleRef);
  let lazy: (() => Promise<TenantCredentialsContract>) | undefined;
  return markResolved(async (): Promise<string> => {
    const getter = instance ?? lazy;
    if (getter) return requireToken(await (await getter()).token());
    const result = await fn();
    const target = lazyDefault(result, 'token');
    if (target === undefined) return requireToken(result);
    lazy = fromModule(target);
    return requireToken(await (await lazy()).token());
  });
}
