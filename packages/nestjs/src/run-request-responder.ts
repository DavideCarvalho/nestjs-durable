import type { RunGateway, RunReply, RunRequest, RunWaiting } from '@dudousxd/nestjs-durable-core';

/** The narrow slice of `Transport` the responder needs — a tenant's read/control request in, a
 *  correlated reply out. Both are OPTIONAL on the full `Transport` interface (only broker
 *  transports carry the run-request/reply protocol); the caller capability-checks before wiring
 *  this up (see `durable.module.ts`). */
export interface RunRequestTransport {
  onRunRequest(handler: (msg: RunRequest) => Promise<void>): void;
  publishRunReply(reply: RunReply): Promise<void>;
}

/**
 * Operator-side consumer of a tenant's {@link RunRequest}s: answers each one against a
 * `RunGateway`, enforcing the tenant boundary before touching the run. For every runId-bearing
 * verb it loads the run via `getRunDetail` FIRST and compares `run.namespace` to the requesting
 * `msg.tenant` — a mismatch short-circuits into a `cross-tenant` error reply WITHOUT calling the
 * verb, so a tenant can never read or act on another tenant's run. `listRuns` is scoped by
 * overwriting the query's `namespace` with the requester's tenant, ignoring whatever the client
 * sent. This is the security boundary of the tenant run gateway — do not weaken it.
 */
export class RunRequestResponder {
  constructor(
    private readonly transport: RunRequestTransport,
    private readonly gateway: RunGateway,
  ) {}

  /** Register the consumer on the transport. Each request is answered independently; a handler
   *  failure never throws back into the transport (errors are captured into an error reply). */
  start(): void {
    this.transport.onRunRequest(async (msg) => {
      const reply = await this.handle(msg);
      await this.transport.publishRunReply(reply);
    });
  }

  private async handle(msg: RunRequest): Promise<RunReply> {
    const { body } = msg;
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

    if (body.kind === 'waitingFor') {
      // Bulk, like `listRuns` — but unlike `listRuns` (which forces the query's namespace and so
      // scopes itself) the caller supplies arbitrary ids, which could probe another tenant's runs. The
      // gateway's own `waitingFor` has no namespace to filter by, so verify ownership per MATCHED entry
      // (bounded by how many of the requested ids are actually waiting, never by `runIds.length`) the
      // same way every other runId-bearing verb does below: `getRunDetail` + a `namespace` check.
      const all = await this.gateway.waitingFor(body.runIds);
      const owned = await Promise.all(
        Object.entries(all).map(async ([runId, waiting]) => {
          const runDetail = await this.gateway.getRunDetail(runId);
          return runDetail && runDetail.run.namespace === msg.tenant
            ? ([runId, waiting] as const)
            : undefined;
        }),
      );
      const data: Record<string, RunWaiting> = {};
      for (const entry of owned) {
        if (entry) data[entry[0]] = entry[1];
      }
      return { requestId: msg.requestId, result: { ok: true, data } };
    }

    // Every remaining verb is runId-bearing. Load the run FIRST — before calling the verb — so a
    // cross-tenant request never reaches the gateway's mutating methods (cancel/retry/continue/redispatch).
    const detail = await this.gateway.getRunDetail(body.runId);
    if (detail && detail.run.namespace !== msg.tenant) {
      return {
        requestId: msg.requestId,
        result: {
          ok: false,
          error: { message: 'run belongs to another tenant', code: 'cross-tenant' },
        },
      };
    }

    if (body.kind === 'getRunDetail') {
      return { requestId: msg.requestId, result: { ok: true, data: detail } };
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

  private callVerb(
    body: Exclude<
      RunRequest['body'],
      | { kind: 'listRuns' }
      | { kind: 'runFacets' }
      | { kind: 'runValueFacets' }
      | { kind: 'getRunDetail' }
      | { kind: 'workerHealth' }
      | { kind: 'waitingFor' }
    >,
  ): Promise<unknown> {
    switch (body.kind) {
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
