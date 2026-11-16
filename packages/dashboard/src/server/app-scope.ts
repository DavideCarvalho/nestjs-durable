import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  LifecycleSubscriptionLink,
  RunFacetQuery,
  RunGateway,
  RunQuery,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

/**
 * The apps a console viewer may see on a control plane, from `authorize`'s `apps` grant (the same
 * shape every Aviary console takes): a tenant app's runs live in its partition (`run.namespace`), its
 * workers in `<name>@<app>` groups, its schedules in its namespace. `'*'` or an omitted grant is
 * every app plus the control plane's own runs; a list confines the console (listings, counts,
 * facets, run reads, live tail, every action, worker health, schedules) to those apps, and the
 * process-wide `/metrics` is refused.
 */
export type ConsoleAppGrant = '*' | string[] | undefined;

/** The apps of a grant that confines, or `undefined` for every app. */
export function grantedApps(grant: ConsoleAppGrant): string[] | undefined {
  return grant === undefined || grant === '*' ? undefined : grant;
}

/** Where the guard leaves the request's grant for {@link ConsoleAppScopeInterceptor}. */
export const CONSOLE_APPS = Symbol.for('@dudousxd/nestjs-durable-dashboard:console-apps');

const appScope = new AsyncLocalStorage<readonly string[]>();

/** The apps the current console request is confined to, or `undefined` for every app. */
export function currentConsoleApps(): readonly string[] | undefined {
  return appScope.getStore();
}

/** Run `fn` confined to `apps` (`undefined`: every app). */
export function withConsoleApps<T>(apps: readonly string[] | undefined, fn: () => T): T {
  return apps === undefined ? fn() : appScope.run(apps, fn);
}

/**
 * Runs each console handler inside the request's app grant (left on the request by the console
 * guard), so every read and action it makes is confined to those apps. A no-op without a grant.
 */
@Injectable()
export class ConsoleAppScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request =
      context.getType() === 'http'
        ? context.switchToHttp().getRequest<Record<symbol, unknown> | undefined>()
        : undefined;
    const apps = request?.[CONSOLE_APPS] as readonly string[] | undefined;
    if (apps === undefined) return next.handle();
    // Subscribing inside the scope runs the handler (and every async continuation it starts) in it.
    return new Observable((subscriber) =>
      appScope.run(apps, () => next.handle().subscribe(subscriber)),
    );
  }
}

/** Whether `namespace` belongs to one of `apps`. */
export function namespaceInApps(namespace: string | undefined, apps: readonly string[]): boolean {
  return namespace !== undefined && apps.includes(namespace);
}

/** `query` narrowed to `apps`: its own namespace filter kept only where it is one of them. */
export function narrowToApps<Q extends Pick<RunQuery, 'namespace' | 'namespaces'>>(
  query: Q,
  apps: readonly string[],
): Q {
  const { namespace, namespaces, ...rest } = query;
  let allowed: string[] = [...apps];
  if (namespace !== undefined) allowed = apps.includes(namespace) ? [namespace] : [];
  if (namespaces !== undefined) allowed = allowed.filter((app) => namespaces.includes(app));
  // An empty `namespaces` matches nothing.
  return { ...rest, namespaces: allowed } as unknown as Q;
}

/** Whether `run` (`null`: unknown) belongs to one of `apps`. */
export function runInApps(
  run: Pick<WorkflowRun, 'namespace'> | null | undefined,
  apps: readonly string[],
): boolean {
  return run != null && namespaceInApps(run.namespace, apps);
}

/**
 * `gateway` confined to `apps`: listings, counts and facets are narrowed to their namespaces, a run
 * outside them reads as missing and every action on it answers not-found (`null`), and worker health
 * keeps their `<name>@<app>` groups.
 */
export function appScopedGateway(gateway: RunGateway, apps: readonly string[]): RunGateway {
  const runOf = async (runId: string): Promise<WorkflowRun | null> =>
    gateway.getRun
      ? gateway.getRun(runId)
      : ((await gateway.getRunDetail(runId, { summarizeFansOver: 0 }))?.run ?? null);
  const sees = async (runId: string) => runInApps(await runOf(runId), apps);
  const guard =
    <A extends unknown[], R>(fn: (runId: string, ...rest: A) => Promise<R>, hidden: R) =>
    async (runId: string, ...rest: A): Promise<R> =>
      (await sees(runId)) ? fn(runId, ...rest) : hidden;
  const scoped: RunGateway = {
    topology: () => gateway.topology(),
    getRunDetail: async (runId, options) => {
      const detail = await gateway.getRunDetail(runId, options);
      return detail && runInApps(detail.run, apps) ? detail : null;
    },
    getRun: async (runId) => {
      const run = await runOf(runId);
      return runInApps(run, apps) ? run : null;
    },
    listRuns: (query) => gateway.listRuns(narrowToApps(query, apps)),
    runFacets: (query: RunFacetQuery) => gateway.runFacets(narrowToApps(query, apps)),
    runValueFacets: (axis, query, opts) =>
      gateway.runValueFacets(axis, narrowToApps(query, apps), opts),
    // Only the runs of the apps: an id of another app's run answers as not waiting.
    waitingFor: async (runIds) => {
      const visible: string[] = [];
      for (const id of runIds) if (await sees(id)) visible.push(id);
      return visible.length > 0 ? gateway.waitingFor(visible) : {};
    },
    workerHealth: async () =>
      (await gateway.workerHealth()).filter((g) => apps.some((app) => g.group.endsWith(`@${app}`))),
    cancel: guard((id, opts?: { compensate?: boolean }) => gateway.cancel(id, opts), null),
    retry: guard((id) => gateway.retry(id), null),
    continue: guard((id) => gateway.continue(id), null),
    redispatchPending: guard((id) => gateway.redispatchPending(id), null),
    retryWithInput: guard((id, input: unknown) => gateway.retryWithInput(id, input), null),
    // A live tail is checked by the caller before it subscribes (the check is async).
    subscribe: (runId, onEvent) => gateway.subscribe(runId, onEvent),
  };
  if (gateway.getFanMembers) {
    const fn = gateway.getFanMembers.bind(gateway);
    scoped.getFanMembers = guard((id, group: string, query) => fn(id, group, query), null);
  }
  if (gateway.workflowLifecycle) {
    const fn = gateway.workflowLifecycle.bind(gateway);
    // The links of the apps' subscriptions only: one read per app (or the asked one), merged.
    scoped.workflowLifecycle = async (workflow, opts) => {
      const namespaces =
        opts?.namespace !== undefined
          ? apps.includes(opts.namespace)
            ? [opts.namespace]
            : []
          : apps;
      const answers = await Promise.all(namespaces.map((namespace) => fn(workflow, { namespace })));
      return {
        workflow,
        startsOnSettle: mergeLinks(answers.flatMap((a) => a.startsOnSettle)),
        startedBy: mergeLinks(answers.flatMap((a) => a.startedBy)),
      };
    };
  }
  if (gateway.lifecycleSubscribers) {
    const fn = gateway.lifecycleSubscribers.bind(gateway);
    scoped.lifecycleSubscribers = async (workflow, kind, namespace) =>
      apps.includes(namespace) ? fn(workflow, kind, namespace) : [];
  }
  if (gateway.republishLifecycle) {
    const fn = gateway.republishLifecycle.bind(gateway);
    scoped.republishLifecycle = async (target) => {
      if ('runId' in target) {
        if (!(await sees(target.runId))) throw new Error(`run ${target.runId} not found`);
        return fn(target);
      }
      // A by-workflow republish reaches one app's runs at a time.
      const namespace = target.namespace;
      if (namespace === undefined || !apps.includes(namespace)) {
        throw Object.assign(
          new Error('republish by workflow needs one of your apps as namespace'),
          {
            code: 'bad-request',
          },
        );
      }
      return fn(target);
    };
  }
  return scoped;
}

/** Links from several namespaces' answers, one per (workflow, kind), sorted like the engine's. */
function mergeLinks(links: LifecycleSubscriptionLink[]): LifecycleSubscriptionLink[] {
  const byKey = new Map<string, LifecycleSubscriptionLink>();
  for (const link of links) byKey.set(`${link.workflow}\u0000${link.kind}`, link);
  return [...byKey.values()].sort(
    (a, b) => a.workflow.localeCompare(b.workflow) || a.kind.localeCompare(b.kind),
  );
}
