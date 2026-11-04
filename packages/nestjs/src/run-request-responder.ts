import {
  type LifecycleKind,
  type RepublishLifecycleTarget,
  type RunDetail,
  type RunGateway,
  type RunReply,
  type RunRequest,
  type RunRequestKind,
  type RunWaiting,
  type TenantVerifier,
  lifecycleKindOf,
  resolveWireTenant,
} from '@dudousxd/nestjs-durable-core';

/**
 * The error `code` a responder replies with for a verb it does not know, so a newer tenant can tell
 * "this control plane is older than me" from a real failure and fall back at once. Earlier
 * responders reply `ok: true` with no `data` instead; `ProxyRunGateway` reads both.
 */
export const UNSUPPORTED_RUN_REQUEST = 'unsupported-request';

/** The error `code` a responder replies with for a request it rejects as malformed or not allowed. */
export const BAD_RUN_REQUEST = 'bad-request';

/** The most settled runs one tenant republish reads; a larger `limit` is lowered to it. */
export const TENANT_REPUBLISH_MAX_LIMIT = 1000;

const KNOWN_KINDS: ReadonlySet<string> = new Set<RunRequestKind['kind']>([
  'getRunDetail',
  'getFanMembers',
  'getRun',
  'listRuns',
  'runFacets',
  'runValueFacets',
  'workerHealth',
  'cancel',
  'retry',
  'continue',
  'retryWithInput',
  'redispatch',
  'waitingFor',
  'republishLifecycle',
  'workflowLifecycle',
]);

/** A wire `since`/`until` (an ISO string after JSON) back to a `Date`. */
function wireDate(value: Date | string | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date ${String(value)}`);
  return date;
}

/** The narrow slice of `Transport` the responder needs — a tenant's read/control request in, a
 *  correlated reply out. Both are OPTIONAL on the full `Transport` interface (only broker
 *  transports carry the run-request/reply protocol); the caller capability-checks before wiring
 *  this up (see `durable.module.ts`). */
export interface RunRequestTransport {
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void;
  publishRunReply(reply: RunReply): Promise<void>;
}

/** Options for {@link RunRequestResponder}. */
export interface RunRequestResponderOptions {
  /**
   * Verifies the signed token a tenant presents in the wire `tenant` field and DERIVES the real
   * tenant from it (see `hmacTenantVerifier`). Present: an invalid, tampered or absent token is
   * rejected with an `unauthorized` error reply and the wire claim is discarded in favour of the
   * verified tenant. Absent: the wire `tenant` is trusted verbatim (prefix/network isolation only).
   */
  verifyTenant?: TenantVerifier | undefined;
  /**
   * Warn at construction when no {@link verifyTenant} is set. Default `true`. `DurableModule` passes
   * `true` only for an explicit `topology: { role: 'control-plane' }`, so a plain operator app that
   * never serves tenants boots silently.
   */
  warnWithoutVerifier?: boolean | undefined;
}

/**
 * Operator-side consumer of a tenant's {@link RunRequest}s: answers each one against a
 * `RunGateway`, enforcing the tenant boundary before touching the run. For every runId-bearing
 * verb it loads the run via `getRunDetail` FIRST and compares `run.namespace` to the requesting
 * `msg.tenant` — a mismatch short-circuits into a `cross-tenant` error reply WITHOUT calling the
 * verb, so a tenant can never read or act on another tenant's run. `listRuns` is scoped by
 * overwriting the query's `namespace` with the requester's tenant, ignoring whatever the client
 * sent. This is the security boundary of the tenant run gateway — do not weaken it.
 *
 * With {@link RunRequestResponderOptions.verifyTenant}, every request is authenticated FIRST: the
 * wire `tenant` is treated as a signed token, the real tenant is derived from it, and an invalid
 * token short-circuits into an `unauthorized` error reply before any run is touched. A verifier
 * that throws becomes an error reply too.
 */
/**
 * `detail` with its links to other runs kept to `tenant`'s namespace: `awaitedBy` without the
 * waiting runs of other namespaces, and what was read of a `triggeredBy`, `waitsFor` or started
 * `lifecycleDeliveries` run (its status, namespace and trace id) only when that run is the tenant's.
 */
function scopeRunLinks(detail: RunDetail, tenant: string): RunDetail {
  const own = (link: { namespace?: string | undefined }) => link.namespace === tenant;
  const bare = <T extends { status?: unknown; namespace?: string | undefined }>(link: T): T => {
    if (own(link)) return link;
    const { status: _status, namespace: _namespace, ...rest } = link;
    return rest as T;
  };
  const awaitedBy = detail.awaitedBy?.filter(own);
  const { awaitedBy: _awaitedBy, ...rest } = detail;
  const source = detail.triggeredBy;
  return {
    ...rest,
    ...(source
      ? { triggeredBy: own(source) ? source : { runId: source.runId, kind: source.kind } }
      : {}),
    ...(awaitedBy && awaitedBy.length > 0 ? { awaitedBy } : {}),
    ...(detail.waitsFor ? { waitsFor: detail.waitsFor.map(bare) } : {}),
    ...(detail.lifecycleDeliveries
      ? { lifecycleDeliveries: detail.lifecycleDeliveries.map(bare) }
      : {}),
  };
}

export class RunRequestResponder {
  private readonly verifyTenant: TenantVerifier | undefined;

  constructor(
    private readonly transport: RunRequestTransport,
    private readonly gateway: RunGateway,
    options: RunRequestResponderOptions = {},
  ) {
    this.verifyTenant = options.verifyTenant;
    if (!this.verifyTenant && options.warnWithoutVerifier !== false) {
      // Loud on purpose: without a verifier the anti-IDOR checks below are bypassable by CLAIMING
      // another tenant's name in the wire `tenant` field. Prefix/network isolation may be an
      // acceptable posture, but it must be a chosen one.
      console.warn(
        '[nestjs-durable] run-request responder started WITHOUT a tenant verifier: the wire ' +
          '`tenant` claim is trusted verbatim (prefix/network isolation only). Any broker client ' +
          'can act as any tenant. Configure `verifyTenant` (e.g. hmacTenantVerifier(secret)) and ' +
          'signed tenant tokens unless your broker is fully isolated per tenant.',
      );
    }
  }

  /** Register the consumer on the transport. Each request is answered independently; a handler
   *  failure never throws back into the transport (errors are captured into an error reply). */
  start(): void {
    this.transport.onRunRequest(async (msg) => {
      let reply: RunReply;
      try {
        reply = await this.handle(msg);
      } catch (err) {
        // Without a reply the tenant waits out its whole timeout for an answer that never comes.
        reply = {
          requestId: msg.requestId,
          result: {
            ok: false,
            error: { message: err instanceof Error ? err.message : String(err) },
          },
        };
      }
      await this.transport.publishRunReply(reply);
    });
  }

  private async handle(wire: RunRequest): Promise<RunReply> {
    const tenant = await resolveWireTenant(wire.tenant, this.verifyTenant);
    if (tenant === null) {
      return {
        requestId: wire.requestId,
        result: {
          ok: false,
          error: { message: 'invalid or unauthorized tenant token', code: 'unauthorized' },
        },
      };
    }
    // From here on `msg.tenant` is the VERIFIED tenant (the wire claim itself when no verifier is set).
    const msg: RunRequest = { ...wire, tenant };
    const { body } = msg;
    if (!KNOWN_KINDS.has(body.kind)) return unsupported(msg.requestId, String(body.kind));
    if (body.kind === 'listRuns') {
      // Force the namespace to the requester's tenant — the client-supplied value is discarded,
      // never merely validated, so a tenant can't widen its own query into another's namespace.
      const data = await this.gateway.listRuns({ ...body.query, namespace: msg.tenant });
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    if (body.kind === 'runFacets') {
      // Same forced scope as `listRuns` above, for the same reason: the counts label a tenant's own
      // page, so they must be taken over exactly that tenant's runs and no one else's.
      const data = await this.gateway.runFacets({ ...body.query, namespace: msg.tenant });
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    if (body.kind === 'runValueFacets') {
      // Same forced scope as `listRuns`/`runFacets`: the values fill a picker for the tenant's own
      // list, so enumerating them over anyone else's runs would both leak other tenants' tag and
      // attribute vocabulary and offer choices this tenant's list can never match.
      const data = await this.gateway.runValueFacets(
        body.axis,
        { ...body.query, namespace: msg.tenant },
        body.opts,
      );
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    if (body.kind === 'workerHealth') {
      // Not runId-bearing, so it can't ride the getRunDetail namespace check below. Scope by the
      // group-name convention instead: a tenant's queues are suffixed `<name>@<tenant>`, so keep only
      // groups ending in the requester's `@<tenant>` — the operator's own bare groups and every other
      // tenant's are dropped, so a tenant's Workers panel only ever sees ITS OWN queues.
      const all = await this.gateway.workerHealth();
      const data = all.filter((h) => h.group.endsWith(`@${msg.tenant}`));
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    if (body.kind === 'workflowLifecycle') {
      if (!this.gateway.workflowLifecycle) return unsupported(msg.requestId, body.kind);
      // Scoped to the requester: subscribers another tenant registers or announces stay unseen.
      const data = await this.gateway.workflowLifecycle(body.workflow, { namespace: msg.tenant });
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    if (body.kind === 'republishLifecycle' && !('runId' in body.target)) {
      // Not runId-bearing: forced onto the requester's namespace, like `listRuns`, so a tenant can
      // only republish its own runs whatever namespace it sent.
      if (!this.gateway.republishLifecycle) return unsupported(msg.requestId, body.kind);
      const { since, until, limit, ...rest } = body.target as Extract<
        RepublishLifecycleTarget,
        { workflow: string }
      > & { since?: Date | string; until?: Date | string };
      if (
        limit !== undefined &&
        (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1)
      ) {
        return badRequest(
          msg.requestId,
          `limit must be a positive integer, got ${JSON.stringify(limit)}`,
        );
      }
      const refused = await this.refuseSubscriber(
        rest.workflow,
        rest.kind,
        rest.subscriber,
        msg.tenant,
      );
      if (refused) return badRequest(msg.requestId, refused);
      const target: RepublishLifecycleTarget = {
        ...rest,
        namespace: msg.tenant,
        limit: Math.min(limit ?? TENANT_REPUBLISH_MAX_LIMIT, TENANT_REPUBLISH_MAX_LIMIT),
        ...(since !== undefined ? { since: wireDate(since) } : {}),
        ...(until !== undefined ? { until: wireDate(until) } : {}),
      };
      try {
        const data = await this.gateway.republishLifecycle(target);
        return { requestId: msg.requestId, result: { ok: true, data } };
      } catch (err) {
        return {
          requestId: msg.requestId,
          result: {
            ok: false,
            error: { message: err instanceof Error ? err.message : String(err) },
          },
        };
      }
    }

    if (body.kind === 'waitingFor') {
      // Bulk, like `listRuns` — but unlike `listRuns` (which forces the query's namespace and so
      // scopes itself) the caller supplies arbitrary ids, which could probe another tenant's runs. The
      // gateway's own `waitingFor` has no namespace to filter by, so verify ownership per MATCHED entry
      // (bounded by how many of the requested ids are actually waiting, never by `runIds.length`) the
      // same way every other runId-bearing verb does below: `getRunDetail` + a `namespace` check.
      const all = await this.gateway.waitingFor(body.runIds);
      const owned = await Promise.all(
        Object.entries(all).map(async ([runId, waiting]) => {
          const owner = this.gateway.getRun
            ? await this.gateway.getRun(runId)
            : (await this.gateway.getRunDetail(runId))?.run;
          return owner && owner.namespace === msg.tenant ? ([runId, waiting] as const) : undefined;
        }),
      );
      const data: Record<string, RunWaiting> = {};
      for (const entry of owned) {
        if (entry) data[entry[0]] = entry[1];
      }
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    if (body.kind === 'republishLifecycle' && !this.gateway.republishLifecycle) {
      return unsupported(msg.requestId, body.kind);
    }

    // Every remaining verb is runId-bearing. Load the run FIRST — before calling the verb — so a
    // cross-tenant request never reaches the gateway's mutating methods (cancel/retry/continue/redispatch).
    // Only `getRunDetail` needs the timeline; every other verb checks ownership on the run alone.
    const runId = runIdOf(body);
    const detail =
      body.kind === 'getRunDetail' || !this.gateway.getRun
        ? await this.gateway.getRunDetail(
            runId,
            body.kind === 'getRunDetail' ? body.options : undefined,
          )
        : undefined;
    const run = detail !== undefined ? (detail?.run ?? null) : await this.gateway.getRun?.(runId);
    if (run && run.namespace !== msg.tenant) {
      return {
        requestId: msg.requestId,
        result: {
          ok: false,
          error: { message: 'run belongs to another tenant', code: 'cross-tenant' },
        },
      };
    }

    if (body.kind === 'getRunDetail') {
      const data = detail ? await this.scopeLifecycle(detail, msg.tenant) : detail;
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    if (body.kind === 'getRun') {
      return { requestId: msg.requestId, result: { ok: true, data: run ?? null } };
    }

    if (body.kind === 'getFanMembers') {
      const data = run
        ? ((await this.gateway.getFanMembers?.(body.runId, body.group, body.query)) ?? null)
        : null;
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    if (body.kind === 'republishLifecycle' && 'runId' in body.target && run) {
      const kind = lifecycleKindOf(run.status);
      const refused = kind
        ? await this.refuseSubscriber(run.workflow, kind, body.target.subscriber, msg.tenant)
        : undefined;
      if (refused) return badRequest(msg.requestId, refused);
    }

    try {
      const data = await this.callVerb(body);
      return { requestId: msg.requestId, result: { ok: true, data } };
    } catch (err) {
      return {
        requestId: msg.requestId,
        result: { ok: false, error: { message: err instanceof Error ? err.message : String(err) } },
      };
    }
  }

  /**
   * `detail` scoped to `tenant` (see {@link scopeRunLinks}), with its lifecycle links
   * (`workflowLifecycle`, `lifecycleSubscribers`) narrowed to the subscriptions of `tenant`'s
   * namespace, as the `workflowLifecycle` verb answers them.
   */
  private async scopeLifecycle(input: RunDetail, tenant: string): Promise<RunDetail> {
    const detail = scopeRunLinks(input, tenant);
    if (detail.workflowLifecycle === undefined && detail.lifecycleSubscribers === undefined) {
      return detail;
    }
    const { workflowLifecycle: _links, lifecycleSubscribers: _subscribers, ...rest } = detail;
    const links = await this.gateway.workflowLifecycle?.(detail.run.workflow, {
      namespace: tenant,
    });
    if (!links) return rest;
    const kind = lifecycleKindOf(detail.run.status);
    const subscribers = kind
      ? [...new Set(links.startsOnSettle.filter((l) => l.kind === kind).map((l) => l.workflow))]
      : [];
    const linked = links.startsOnSettle.length > 0 || links.startedBy.length > 0;
    return {
      ...rest,
      ...(subscribers.length > 0 ? { lifecycleSubscribers: subscribers } : {}),
      ...(linked ? { workflowLifecycle: links } : {}),
    };
  }

  /**
   * Why a tenant republish naming `subscriber` is refused, or undefined when it may go ahead: the
   * subscriber must be owed the event of `workflow` settling (as `kind`, when given) by a run of
   * the tenant's namespace (the gateway's `lifecycleSubscribers`, else the tenant's
   * `workflowLifecycle` links), so a tenant cannot have the event owed to an arbitrary name. Without
   * `subscriber` there is nothing to check.
   */
  private async refuseSubscriber(
    workflow: string,
    kind: LifecycleKind | undefined,
    subscriber: string | undefined,
    tenant: string,
  ): Promise<string | undefined> {
    if (subscriber === undefined) return undefined;
    const kinds: LifecycleKind[] = kind ? [kind] : ['completed', 'failed'];
    let subscribes = false;
    if (this.gateway.lifecycleSubscribers) {
      for (const k of kinds) {
        const subscribers = await this.gateway.lifecycleSubscribers(workflow, k, tenant);
        subscribes ||= subscribers.includes(subscriber);
      }
    } else {
      const links = await this.gateway.workflowLifecycle?.(workflow, { namespace: tenant });
      subscribes =
        links?.startsOnSettle.some(
          (link) => link.workflow === subscriber && kinds.includes(link.kind),
        ) ?? false;
    }
    if (subscribes) return undefined;
    const events = kind
      ? `run.${kind}:${workflow}`
      : `run.completed:${workflow} or run.failed:${workflow}`;
    return `subscriber ${subscriber} does not subscribe to ${events} in namespace ${tenant}`;
  }

  private callVerb(
    body: Exclude<
      RunRequest['body'],
      | { kind: 'listRuns' }
      | { kind: 'runFacets' }
      | { kind: 'runValueFacets' }
      | { kind: 'getRunDetail' }
      | { kind: 'getFanMembers' }
      | { kind: 'getRun' }
      | { kind: 'workerHealth' }
      | { kind: 'waitingFor' }
      | { kind: 'workflowLifecycle' }
    >,
  ): Promise<unknown> {
    switch (body.kind) {
      case 'republishLifecycle':
        return (
          this.gateway.republishLifecycle?.(body.target) ??
          Promise.reject(new Error('republishLifecycle is not supported'))
        );
      case 'cancel':
        return this.gateway.cancel(body.runId, body.opts);
      case 'retry':
        return this.gateway.retry(body.runId);
      case 'continue':
        return this.gateway.continue(body.runId);
      case 'retryWithInput':
        return this.gateway.retryWithInput(body.runId, body.input);
      case 'redispatch':
        return this.gateway.redispatchPending(body.runId);
    }
  }
}

/** The run a runId-bearing request acts on; a one-run republish names it in its target. */
function runIdOf(
  body: Exclude<
    RunRequestKind,
    | { kind: 'listRuns' }
    | { kind: 'runFacets' }
    | { kind: 'runValueFacets' }
    | { kind: 'workerHealth' }
    | { kind: 'waitingFor' }
    | { kind: 'workflowLifecycle' }
  >,
): string {
  if (body.kind !== 'republishLifecycle') return body.runId;
  return 'runId' in body.target ? body.target.runId : '';
}

/** The reply to a request this responder rejects (see {@link BAD_RUN_REQUEST}). */
function badRequest(requestId: string, message: string): RunReply {
  return { requestId, result: { ok: false, error: { message, code: BAD_RUN_REQUEST } } };
}

/** The reply to a verb this responder knows but its gateway cannot answer. */
function unsupported(requestId: string, kind: string): RunReply {
  return {
    requestId,
    result: {
      ok: false,
      error: {
        message: `the control plane does not support the ${kind} run request`,
        code: UNSUPPORTED_RUN_REQUEST,
      },
    },
  };
}
