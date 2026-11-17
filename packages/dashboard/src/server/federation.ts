import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConsoleFederation, RunGateway } from '@dudousxd/nestjs-durable-core';

/**
 * Another app a federated console shows (see {@link DurableConsoleFederation}). Its runs, schedules
 * and workers are read through `gateway`, and its actions go through it too, so the gateway decides
 * who executes them: `federatedAppGateway` (from `@dudousxd/nestjs-durable`) reads the app's store
 * and sends every action to the app over its broker, where the app's own engine executes it.
 */
export interface FederatedConsoleApp {
  /**
   * The app's name: what the console's URL selects (`?app=<name>`) and what an `authorize` `apps`
   * grant names to let a viewer see it.
   */
  name: string;
  /** Shown in the app switcher. Default: {@link name}. */
  label?: string;
  /** Reads and actions for this app. */
  gateway: RunGateway;
}

/**
 * The dashboard's `federation` option: one console (typically on a central "hub" app) that shows
 * the runs of several apps, each kept in its own store and executed by its own engine. The console
 * gets an app switcher, the selected app is in the URL (`?app=<name>`), and every read and action of
 * a request is served by that app's gateway. No app selected is the console's own app, as before.
 */
export interface DurableConsoleFederation {
  /** The other apps. Names must be unique. */
  apps: FederatedConsoleApp[];
  /** How the console's own app is labelled in the switcher. Default `'this app'`. */
  localLabel?: string;
}

/** DI token carrying the {@link DurableConsoleFederation} (absent: no federation). */
export const DASHBOARD_FEDERATION: symbol = Symbol.for(
  '@dudousxd/nestjs-durable-dashboard:federation',
);

/** The request header the console's client names the selected app in. */
export const FEDERATED_APP_HEADER = 'x-durable-app';
/** The query parameter that names it where a header can't be sent (the SSE stream, the page). */
export const FEDERATED_APP_PARAM = 'app';

interface FederatedScope {
  app: FederatedConsoleApp;
  /** The viewer's app grant (`undefined`: every app), for listing the apps it may switch to. */
  grant: readonly string[] | undefined;
}

const federatedScope = new AsyncLocalStorage<FederatedScope>();

/** The app the current console request is for, or `undefined` for the console's own app. */
export function currentFederatedApp(): FederatedConsoleApp | undefined {
  return federatedScope.getStore()?.app;
}

/** The current request's app grant when it is for a federated app (see {@link currentFederatedApp}). */
export function federatedGrant(): readonly string[] | undefined {
  return federatedScope.getStore()?.grant;
}

/** Run `fn` for `app`, with the viewer's `grant`. */
export function withFederatedApp<T>(
  app: FederatedConsoleApp,
  grant: readonly string[] | undefined,
  fn: () => T,
): T {
  return federatedScope.run({ app, grant }, fn);
}

/** The app a console request selects (header first, then `?app=`), or undefined for none. */
export function selectedAppName(request: unknown): string | undefined {
  const req = request as
    | { headers?: Record<string, unknown>; query?: Record<string, unknown> }
    | undefined;
  const header = req?.headers?.[FEDERATED_APP_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === 'string' && fromHeader !== '') return fromHeader;
  const param = req?.query?.[FEDERATED_APP_PARAM];
  return typeof param === 'string' && param !== '' ? param : undefined;
}

/** Throws at boot on an empty or duplicate app name. */
export function assertValidFederation(federation: DurableConsoleFederation | undefined): void {
  if (!federation) return;
  const seen = new Set<string>();
  for (const app of federation.apps) {
    if (typeof app.name !== 'string' || app.name === '') {
      throw new Error('DurableDashboardModule: every federation app needs a non-empty `name`.');
    }
    if (seen.has(app.name)) {
      throw new Error(`DurableDashboardModule: federation app "${app.name}" is listed twice.`);
    }
    if (!app.gateway) {
      throw new Error(`DurableDashboardModule: federation app "${app.name}" needs a \`gateway\`.`);
    }
    seen.add(app.name);
  }
}

/** The switcher's view of `federation` for a viewer holding `grant`, answering for `current`. */
export function describeFederation(
  federation: DurableConsoleFederation,
  grant: readonly string[] | undefined,
  current: string | undefined,
): ConsoleFederation {
  return {
    local: { label: federation.localLabel ?? 'this app' },
    apps: federation.apps
      .filter((app) => grant === undefined || grant.includes(app.name))
      .map((app) => ({ name: app.name, label: app.label ?? app.name })),
    ...(current !== undefined ? { current } : {}),
  };
}
