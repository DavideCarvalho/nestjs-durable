import type { RunGateway, RunReply, RunRequest } from '@dudousxd/nestjs-durable-core';

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

    if (body.kind === 'workerHealth') {
      // Not runId-bearing, so it can't ride the getRunDetail namespace check below. Scope by the
      // group-name convention instead: a tenant's queues are suffixed `<name>@<tenant>`, so keep only
      // groups ending in the requester's `@<tenant>` — the operator's own bare groups and every other
      // tenant's are dropped, so a tenant's Workers panel only ever sees ITS OWN queues.
      const all = await this.gateway.workerHealth();
      const data = all.filter((h) => h.group.endsWith(`@${msg.tenant}`));
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
      { kind: 'listRuns' } | { kind: 'getRunDetail' } | { kind: 'workerHealth' }
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
