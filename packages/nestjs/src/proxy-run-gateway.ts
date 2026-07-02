import type {
  EngineEvent,
  RunDetail,
  RunGateway,
  RunQuery,
  RunReply,
  RunRequestKind,
  RunResult,
  Transport,
  WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';

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

  constructor(
    private readonly transport: Transport,
    private readonly tenant: string,
    private readonly timeoutMs = 10_000,
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
    } else {
      pending.reject(new Error(reply.result.error.message));
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
      this.transport
        .dispatchRunRequest?.({ requestId, tenant: this.tenant, body })
        .catch((error: unknown) => {
          const stillPending = this.pending.get(requestId);
          if (!stillPending) return;
          clearTimeout(stillPending.timer);
          this.pending.delete(requestId);
          stillPending.reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  getRunDetail(runId: string): Promise<RunDetail | null> {
    return this.request<RunDetail | null>({ kind: 'getRunDetail', runId });
  }

  listRuns(query: RunQuery): Promise<WorkflowRun[]> {
    return this.request<WorkflowRun[]>({ kind: 'listRuns', query });
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

  subscribe(runId: string, onEvent: (event: EngineEvent) => void): () => void {
    const unsubscribe = this.transport.onTenantEvent?.(this.tenant, (evt) => {
      if (evt.event.runId === runId) onEvent(evt.event);
    });
    return unsubscribe ?? (() => {});
  }
}
