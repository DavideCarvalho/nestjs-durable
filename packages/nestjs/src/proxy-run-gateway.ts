import type {
  DurableTopology,
  EngineEvent,
  FanPage,
  FanPageQuery,
  GroupHealth,
  RunDetail,
  RunDetailOptions,
  RunFacetQuery,
  RunFacetRow,
  RunGateway,
  RunListItem,
  RunQuery,
  RunReply,
  RunRequestKind,
  RunResult,
  RunValueAxis,
  RunValueFacetOptions,
  RunValueFacetRow,
  RunWaiting,
  TenantTokenSource,
  Transport,
} from '@dudousxd/nestjs-durable-core';
import {
  SUMMARY_CHILD_LIMIT,
  childIdsOf,
  pageFan,
  resolveTenantToken,
  summarizeTimeline,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { UNSUPPORTED_RUN_REQUEST } from './run-request-responder';

/**
 * Method-shorthand signatures (not arrow-function-typed properties) are deliberate: TypeScript
 * checks method parameters bivariantly, so a `Promise<T>`'s own `resolve`/`reject` (typed for that
 * call's concrete `T`) can be stored here erased to `unknown` with no cast — the one place the
 * generic `T` from {@link ProxyRunGateway.request} crosses into the untyped bookkeeping map.
 */
interface PendingRequest {
  resolve(data: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** The control plane answered a verb it does not know — an older release than this tenant's. */
class UnsupportedRunRequestError extends Error {}

/** An {@link UNSUPPORTED_RUN_REQUEST} error reply. Older responders answer an unknown verb with
 *  `ok: true` and no `data` instead, which `getFanMembers` checks for itself. */
function isUnsupported(err: unknown): boolean {
  return err instanceof UnsupportedRunRequestError;
}

/**
 * Tenant-side `RunGateway` — round-trips every verb as a `RunRequest`/`RunReply` pair over the
 * transport, correlated by a minted `requestId`, and bridges `subscribe` onto the transport's
 * per-tenant event stream. Bound under `RUN_GATEWAY` by `DurableModule`'s thin-worker role
 * (`connection` set, no `store`) when the app supplies a `transport` (see `unavailableRunGateway`
 * for the no-transport fallback). The counterpart to the operator-side `StoreRunGateway`: a tenant
 * worker never touches a store/driver directly, only this proxy.
 */
@Injectable()
export class ProxyRunGateway implements RunGateway {
  private readonly pending = new Map<string, PendingRequest>();
  /** Verb → when to ask the control plane for it again, after it answered that it does not know it.
   *  During a rolling upgrade the control plane is several pods of mixed versions behind one queue,
   *  and a reply does not say which pod sent it, so the whole control plane is assumed old until the
   *  entry expires. */
  private readonly unsupportedUntil = new Map<RunRequestKind['kind'], number>();

  constructor(
    private readonly transport: Transport,
    private readonly tenant: string,
    private readonly timeoutMs = 10_000,
    private readonly capabilityTtlMs = 60_000,
    /**
     * The tenant's signed token (see `signTenantToken`), presented VERBATIM in the `tenant` field of
     * every {@link RunRequest} so an operator with `verifyTenant` can authenticate it and derive the
     * tenant from it. A function is called before every request (rotation / short-lived tokens).
     * Omit to send the raw `tenant` (prefix/network isolation only). The live-tail channel always
     * stays keyed by `tenant`, never the token: the operator republishes by the run's namespace.
     */
    private readonly tenantToken?: TenantTokenSource,
  ) {
    this.transport.onRunReply?.((reply: RunReply) => this.handleReply(reply));
  }

  private handleReply(reply: RunReply): void {
    const pending = this.pending.get(reply.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(reply.requestId);
    if (reply.result.ok) {
      pending.resolve(reply.result.data);
    } else if (reply.result.error.code === UNSUPPORTED_RUN_REQUEST) {
      pending.reject(new UnsupportedRunRequestError(reply.result.error.message));
    } else {
      // Carry the reply's `code` (`unauthorized`, `cross-tenant`, ...) so a caller can tell an
      // authentication failure from a real one, as Agora's proxy does.
      const { message, code } = reply.result.error;
      pending.reject(
        code !== undefined ? Object.assign(new Error(message), { code }) : new Error(message),
      );
    }
  }

  private request<T>(body: RunRequestKind): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = globalThis.crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new Error(`control plane did not respond to ${body.kind} within ${this.timeoutMs}ms`),
        );
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      // A static token (or none) dispatches synchronously, exactly as before; only a token PROVIDER
      // defers the dispatch until it resolves.
      const source = this.tenantToken;
      const dispatched =
        typeof source === 'function'
          ? resolveTenantToken(source).then((tenant) =>
              this.transport.dispatchRunRequest?.({ requestId, tenant, body }),
            )
          : this.transport.dispatchRunRequest?.({
              requestId,
              tenant: source ?? this.tenant,
              body,
            });
      dispatched?.catch((error: unknown) => {
        const stillPending = this.pending.get(requestId);
        if (!stillPending) return;
        clearTimeout(stillPending.timer);
        this.pending.delete(requestId);
        stillPending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  topology(): DurableTopology {
    return { role: 'tenant', tenant: this.tenant };
  }

  /**
   * A control plane that predates {@link RunDetailOptions} ignores them and sends the full detail;
   * a summarized detail always carries `fans`, so its absence means the summary is made here.
   */
  async getRunDetail(runId: string, options?: RunDetailOptions): Promise<RunDetail | null> {
    const detail = await this.request<RunDetail | null>(
      options === undefined
        ? { kind: 'getRunDetail', runId }
        : { kind: 'getRunDetail', runId, options },
    );
    const over = options?.summarizeFansOver;
    if (over === undefined || !detail || detail.fans !== undefined) return detail;
    const { timeline, fans } = summarizeTimeline(detail.timeline, over);
    const ids = childIdsOf(detail.timeline);
    return {
      ...detail,
      timeline,
      children: ids.slice(0, SUMMARY_CHILD_LIMIT),
      fans,
      childCount: ids.length,
    };
  }

  /** Paged from the full detail when the control plane is too old to page a fan itself. */
  async getFanMembers(runId: string, group: string, query: FanPageQuery): Promise<FanPage | null> {
    if (!this.knownUnsupported('getFanMembers')) {
      try {
        const page = await this.request<FanPage | null | undefined>({
          kind: 'getFanMembers',
          runId,
          group,
          query,
        });
        if (page !== undefined) return page;
      } catch (err) {
        if (!isUnsupported(err)) throw err;
      }
      this.unsupportedUntil.set('getFanMembers', Date.now() + this.capabilityTtlMs);
    }
    const detail = await this.request<RunDetail | null>({ kind: 'getRunDetail', runId });
    return detail ? pageFan(detail.timeline, group, query) : null;
  }

  private knownUnsupported(kind: RunRequestKind['kind']): boolean {
    const until = this.unsupportedUntil.get(kind);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.unsupportedUntil.delete(kind);
    return false;
  }

  /** The control plane's `StoreRunGateway` resolves each run's `waiting` descriptor; the reply carries
   *  it through as plain JSON, so a tenant's list rows name the wait too. */
  listRuns(query: RunQuery): Promise<RunListItem[]> {
    return this.request<RunListItem[]>({ kind: 'listRuns', query });
  }

  /** Counted on the operator, over the same tenant-scoped predicates its `listRuns` reply obeys. */
  runFacets(query: RunFacetQuery): Promise<RunFacetRow[]> {
    return this.request<RunFacetRow[]>({ kind: 'runFacets', query });
  }

  /** Enumerated on the operator, over the same tenant-scoped predicates its `listRuns` reply obeys —
   *  so a tenant's pickers offer its own tenants/tags/attributes and never another's. */
  runValueFacets(
    axis: RunValueAxis,
    query: RunFacetQuery,
    opts?: RunValueFacetOptions,
  ): Promise<RunValueFacetRow[]> {
    return this.request<RunValueFacetRow[]>({ kind: 'runValueFacets', axis, query, opts });
  }

  /** Round-trips to the operator, which scopes the result to this tenant's own `@<tenant>` groups. */
  workerHealth(): Promise<GroupHealth[]> {
    return this.request<GroupHealth[]>({ kind: 'workerHealth' });
  }

  /** Bulk, one request for the whole id list (like `listRuns`, not one request per id). The operator
   *  filters the reply to runs this tenant actually owns (see `RunRequestResponder`). */
  waitingFor(runIds: string[]): Promise<Record<string, RunWaiting>> {
    return this.request<Record<string, RunWaiting>>({ kind: 'waitingFor', runIds });
  }

  cancel(runId: string, opts?: { compensate?: boolean }): Promise<RunResult | null> {
    return this.request<RunResult | null>(
      opts === undefined ? { kind: 'cancel', runId } : { kind: 'cancel', runId, opts },
    );
  }

  retry(runId: string): Promise<RunResult | null> {
    return this.request<RunResult | null>({ kind: 'retry', runId });
  }

  continue(runId: string): Promise<RunResult | null> {
    return this.request<RunResult | null>({ kind: 'continue', runId });
  }

  retryWithInput(runId: string, input: unknown): Promise<{ runId: string } | null> {
    return this.request<{ runId: string } | null>({ kind: 'retryWithInput', runId, input });
  }

  redispatchPending(runId: string): Promise<(RunResult & { redispatched: number }) | null> {
    return this.request<(RunResult & { redispatched: number }) | null>({
      kind: 'redispatch',
      runId,
    });
  }

  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    const unsubscribe = this.transport.onTenantEvent?.(this.tenant, (evt) => {
      if (evt.event.runId === runId) onEvent(evt.event);
    });
    return unsubscribe ?? (() => {});
  }
}
