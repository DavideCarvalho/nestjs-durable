import type { RunReply, RunRequest, TenantEvent, Transport } from '@dudousxd/nestjs-durable-core';
import { DashboardService, DurableDashboardModule } from '@dudousxd/nestjs-durable-dashboard';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { RUN_REDIS_WORKER } from './durable-worker.module';
import { DurableModule } from './durable.module';

/**
 * A store-less thin-worker `runRedisWorker` fake — mirrors `fakeRunner()` in
 * `durable-worker.module.spec.ts` — so `DurableModule.forRoot({ connection })` boots without
 * touching Redis.
 */
function makeRunner() {
  return {
    runRedisWorker: async () => ({ close: async () => {} }),
  };
}

/**
 * A `Transport` fake for the tenant side of the proxy protocol — mirrors `fakeTransport()` in
 * `proxy-run-gateway.spec.ts`. Captures every dispatched `RunRequest` so a test can assert what the
 * dashboard sent over the wire, without a real broker. `dispatch`/`onResult`/`onHeartbeat` are the
 * only non-optional `Transport` members (the remote-step protocol, untouched by the dashboard path)
 * and are wired as no-ops.
 */
function fakeTenantTransport(options: {
  onDispatch: (req: { tenant: string; body: RunRequest['body'] }) => void;
}): Transport {
  let onReply: (reply: RunReply) => void = () => {};
  return {
    dispatch: async () => {},
    onResult: () => {},
    onHeartbeat: () => {},
    onRunReply: (handler: (reply: RunReply) => void) => {
      onReply = handler;
    },
    onTenantEvent: (_tenant: string, _handler: (evt: TenantEvent) => void) => {
      return () => {};
    },
    dispatchRunRequest: async (msg: RunRequest) => {
      options.onDispatch({ tenant: msg.tenant, body: msg.body });
      // Never replies — this spec only asserts what was dispatched, not the round-trip.
      void onReply;
    },
  };
}

describe('a tenant DurableModule (connection only) mounting DurableDashboardModule', () => {
  it('boots the dashboard and drives runs through the ProxyRunGateway', async () => {
    const dispatched: Array<{ tenant: string; body: RunRequest['body'] }> = [];
    const transport = fakeTenantTransport({ onDispatch: (req) => dispatched.push(req) });
    const runner = makeRunner();

    const moduleRef = await Test.createTestingModule({
      imports: [
        DurableModule.forRoot({
          connection: 'redis://x',
          partition: 'tenant-a',
          transport,
        }),
        DurableDashboardModule.forRoot(),
      ],
    })
      .overrideProvider(RUN_REDIS_WORKER)
      .useValue(runner.runRedisWorker)
      .compile();

    // Resolving DashboardService proves: (a) RUN_GATEWAY resolves globally on a tenant (the
    // DurableModule that binds it is `global`), and (b) the constructor did NOT boot-break on
    // `collectMetrics(startClient)` — the store-less start client bound under WorkflowEngine has no
    // `subscribe`, so the guard has to gate the metrics-collector init on store presence.
    const dashboard = moduleRef.get(DashboardService, { strict: false });

    // Run-op: reaches the transport as a proxy request, scoped to the tenant, opts threaded through.
    void dashboard.cancel('run-1', { compensate: true });
    expect(dispatched[0]).toMatchObject({
      tenant: 'tenant-a',
      body: { kind: 'cancel', runId: 'run-1', opts: { compensate: true } },
    });

    // workerHealth now also rides the proxy (the operator scopes the reply to the tenant's own
    // `@<tenant>` groups), so on a tenant it dispatches a request rather than throwing control-plane.
    void dashboard.workerHealth();
    expect(dispatched[1]).toMatchObject({ tenant: 'tenant-a', body: { kind: 'workerHealth' } });

    // The remaining operator-only ops still cleanly reject on a tenant (does NOT call the start
    // client's missing methods, which would throw a confusing `undefined is not a function`).
    await expect(dashboard.metrics()).rejects.toThrow(/control plane/);

    await moduleRef.close();
  });
});
