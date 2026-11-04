import {
  InMemoryStateStore,
  LIFECYCLE_REGISTRY_TAG,
  LIFECYCLE_REGISTRY_WORKFLOW,
  type RunReply,
  type RunRequest,
  type RunRequestKind,
  type Transport,
  type WorkerDescriptor,
  WorkflowEngine,
  type WorkflowRun,
  hmacTenantVerifier,
  lifecycleRunId,
  runCompletedEvent,
  runWaitToken,
  signTenantToken,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { ProxyRunGateway, RunGatewayError } from './proxy-run-gateway';
import {
  RunRequestResponder,
  type RunRequestResponderOptions,
  type RunRequestTransport,
} from './run-request-responder';
import { StoreRunGateway } from './store-run-gateway';

/** A tenant ↔ control plane wire that JSON-encodes every message, as the BullMQ transport does. */
function wire() {
  const requestHandlers: Array<(msg: RunRequest) => Promise<void>> = [];
  const replyHandlers: Array<(reply: RunReply) => void> = [];
  const sent: RunRequestKind[] = [];
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const tenantSide = {
    onRunReply: (handler: (reply: RunReply) => void) => {
      replyHandlers.push(handler);
    },
    dispatchRunRequest: async (msg: RunRequest) => {
      sent.push(json(msg.body));
      for (const handler of requestHandlers) setImmediate(() => void handler(json(msg)));
    },
  } as unknown as Transport;
  const controlPlaneSide: RunRequestTransport = {
    onRunRequest: (handler) => {
      requestHandlers.push(handler);
    },
    publishRunReply: async (reply) => {
      const encoded = json(reply);
      setImmediate(() => {
        for (const h of replyHandlers) h(encoded);
      });
    },
  };
  return { tenantSide, controlPlaneSide, sent };
}

function settled(id: string, namespace: string, updatedAt = new Date()): WorkflowRun {
  return {
    id,
    workflow: 'ingest',
    workflowVersion: '1',
    status: 'completed',
    input: {},
    output: 'ok',
    namespace,
    createdAt: updatedAt,
    updatedAt,
  };
}

/** A control plane with settled `ingest` runs of two tenants and a `refresh` subscriber
 *  registered after they settled. */
async function controlPlane(options: RunRequestResponderOptions = {}) {
  const store = new InMemoryStateStore();
  const engine = new WorkflowEngine({ store });
  engine.register('ingest', '1', async () => 'ok');
  engine.register('refresh', '1', async () => 'refreshed', {
    onEvent: [runCompletedEvent('ingest')],
  });
  await store.createRun(settled('a1', 'acme', new Date('2026-10-01T00:00:00Z')));
  await store.createRun(settled('a2', 'acme', new Date('2026-10-20T00:00:00Z')));
  await store.createRun(settled('b1', 'beta', new Date('2026-10-20T00:00:00Z')));
  const w = wire();
  new RunRequestResponder(w.controlPlaneSide, new StoreRunGateway(store, engine), {
    warnWithoutVerifier: false,
    ...options,
  }).start();
  return { store, engine, w };
}

describe('lifecycle verbs over the tenant proxy', () => {
  it('republishes one of its own runs', async () => {
    const { store, w } = await controlPlane();
    const proxy = new ProxyRunGateway(w.tenantSide, 'acme');

    expect(await proxy.republishLifecycle({ runId: 'a1' })).toEqual({
      runs: 1,
      started: 1,
      failed: [],
    });
    expect(await store.getRun(lifecycleRunId('a1', 'completed', 'refresh'))).not.toBeNull();
    expect(await proxy.republishLifecycle({ runId: 'a1', subscriber: 'refresh' })).toEqual({
      runs: 1,
      started: 0,
      failed: [],
    });
  });

  it("refuses another tenant's run, without republishing it", async () => {
    const { store, w } = await controlPlane();
    const proxy = new ProxyRunGateway(w.tenantSide, 'acme');

    const error = await proxy.republishLifecycle({ runId: 'b1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunGatewayError);
    expect((error as RunGatewayError).code).toBe('cross-tenant');
    expect(await store.getRun(lifecycleRunId('b1', 'completed', 'refresh'))).toBeNull();
  });

  it('republishes by workflow over its own namespace only, whatever namespace it sends', async () => {
    const { store, w } = await controlPlane();
    const proxy = new ProxyRunGateway(w.tenantSide, 'acme');

    expect(
      await proxy.republishLifecycle({
        workflow: 'ingest',
        namespace: 'beta',
        since: new Date('2026-10-10T00:00:00Z'),
      }),
    ).toEqual({ runs: 1, started: 1, failed: [] });
    expect(await store.getRun(lifecycleRunId('a2', 'completed', 'refresh'))).not.toBeNull();
    expect(await store.getRun(lifecycleRunId('a1', 'completed', 'refresh'))).toBeNull();
    expect(await store.getRun(lifecycleRunId('b1', 'completed', 'refresh'))).toBeNull();
    expect(w.sent.at(-1)).toMatchObject({
      kind: 'republishLifecycle',
      target: { workflow: 'ingest', since: '2026-10-10T00:00:00.000Z' },
    });
  });

  it('rejects a limit that is not a positive integer, and lowers a large one to 1000', async () => {
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    engine.register('refresh', '1', async () => 'refreshed', {
      onEvent: [runCompletedEvent('ingest')],
    });
    const targets: unknown[] = [];
    class SpyGateway extends StoreRunGateway {
      override republishLifecycle(target: Parameters<StoreRunGateway['republishLifecycle']>[0]) {
        targets.push(target);
        return super.republishLifecycle(target);
      }
    }
    const w = wire();
    new RunRequestResponder(w.controlPlaneSide, new SpyGateway(store, engine), {
      warnWithoutVerifier: false,
    }).start();
    const proxy = new ProxyRunGateway(w.tenantSide, 'acme');

    for (const limit of [0, -5, 2.5, Number.POSITIVE_INFINITY, '10' as unknown as number]) {
      const error = await proxy
        .republishLifecycle({ workflow: 'ingest', limit })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RunGatewayError);
      expect((error as RunGatewayError).code).toBe('bad-request');
    }
    expect(targets).toEqual([]);

    await proxy.republishLifecycle({ workflow: 'ingest', limit: 1_000_000_000 });
    await proxy.republishLifecycle({ workflow: 'ingest', limit: 7 });
    await proxy.republishLifecycle({ workflow: 'ingest' });
    expect(targets.map((t) => (t as { limit?: number }).limit)).toEqual([1000, 7, 1000]);
  });

  it('rejects a subscriber that does not subscribe in its namespace, stamping nothing', async () => {
    const { store, w } = await controlPlane();
    const proxy = new ProxyRunGateway(w.tenantSide, 'acme');

    for (const call of [
      () => proxy.republishLifecycle({ runId: 'a1', subscriber: 'anything' }),
      () => proxy.republishLifecycle({ workflow: 'ingest', subscriber: 'anything' }),
      () => proxy.republishLifecycle({ workflow: 'ingest', kind: 'failed', subscriber: 'refresh' }),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RunGatewayError);
      expect((error as RunGatewayError).code).toBe('bad-request');
      expect((error as RunGatewayError).message).toMatch(
        /does not subscribe to run\.(completed|failed):ingest/,
      );
    }
    for (const id of ['a1', 'a2']) expect((await store.getRun(id))?.tags ?? []).toEqual([]);
    expect(await store.getRun(lifecycleRunId('a1', 'completed', 'refresh'))).toBeNull();

    expect(
      await proxy.republishLifecycle({
        workflow: 'ingest',
        kind: 'completed',
        subscriber: 'refresh',
      }),
    ).toEqual({ runs: 2, started: 2, failed: [] });
  });

  it("answers a workflow's lifecycle links, for the tenant's namespace", async () => {
    const { w } = await controlPlane();
    // The control plane registers `refresh` itself, in its own namespace (`default`).
    const proxy = new ProxyRunGateway(w.tenantSide, 'default');

    expect(await proxy.workflowLifecycle('ingest')).toMatchObject({
      workflow: 'ingest',
      startsOnSettle: [{ workflow: 'refresh', kind: 'completed', local: true }],
      startedBy: [],
    });
  });

  it('rejects both verbs with an unauthorized token before touching a run', async () => {
    const { store, w } = await controlPlane({ verifyTenant: hmacTenantVerifier('secret') });
    const forged = new ProxyRunGateway(w.tenantSide, 'acme', 10_000, 60_000, 'acme.forged');
    const signed = new ProxyRunGateway(
      w.tenantSide,
      'acme',
      10_000,
      60_000,
      signTenantToken('acme', 'secret'),
    );

    for (const call of [
      () => forged.republishLifecycle({ runId: 'a1' }),
      () => forged.republishLifecycle({ workflow: 'ingest' }),
      () => forged.workflowLifecycle('ingest'),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect((error as RunGatewayError).code).toBe('unauthorized');
    }
    expect(await store.getRun(lifecycleRunId('a1', 'completed', 'refresh'))).toBeNull();

    expect((await signed.republishLifecycle({ runId: 'a1' })).started).toBe(1);
  });
});

describe('lifecycle links over the tenant proxy are scoped to the tenant', () => {
  function descriptor(
    instanceId: string,
    registration: { name: string; group?: string; subscribes: string[] },
    namespace?: string,
  ): WorkerDescriptor {
    return {
      instanceId,
      runtime: 'python',
      sdk: { name: 'sdk', version: '1' },
      protocol: { version: 1, range: [1, 1] },
      capabilities: [],
      workflows: [registration.name],
      steps: [],
      registrations: [registration],
      startedAt: 0,
      ...(namespace !== undefined ? { namespace } : {}),
    };
  }

  async function fleet() {
    const store = new InMemoryStateStore();
    const completed = runCompletedEvent('ingest');
    const transport = {
      async dispatch(): Promise<void> {},
      onResult(): void {},
      onHeartbeat(): void {},
      async readAllWorkerDescriptors(): Promise<WorkerDescriptor[]> {
        return [
          descriptor('py-1', { name: 'py-acme', subscribes: [completed] }, 'acme'),
          descriptor('py-2', { name: 'py-beta', group: 'py-beta@beta', subscribes: [completed] }),
        ];
      },
    } as unknown as Transport;
    const engine = new WorkflowEngine({ store, transport });
    engine.register('ingest', '1', async () => 'ok');
    engine.register('refresh', '1', async () => 'ok', { onEvent: [completed] });
    for (const [instance, namespace, workflow] of [
      ['node-acme', 'acme', 'acme-notify'],
      ['node-beta', 'beta', 'beta-audit'],
    ] as const) {
      const at = new Date();
      await store.createRun({
        id: `${LIFECYCLE_REGISTRY_WORKFLOW}:${instance}`,
        workflow: LIFECYCLE_REGISTRY_WORKFLOW,
        workflowVersion: '1',
        status: 'completed',
        input: {
          instanceId: instance,
          runtime: 'node',
          subscriptions: [{ workflow, events: [completed] }],
        },
        tags: [LIFECYCLE_REGISTRY_TAG],
        namespace,
        createdAt: at,
        updatedAt: at,
      });
    }
    await store.createRun(settled('a1', 'acme'));
    const gateway = new StoreRunGateway(store, engine);
    const w = wire();
    new RunRequestResponder(w.controlPlaneSide, gateway, { warnWithoutVerifier: false }).start();
    return { gateway, w, store };
  }

  const names = (links: { workflow: string }[] | undefined) => links?.map((l) => l.workflow);

  it('lists only the subscribers registered or announced in the tenant namespace', async () => {
    const { gateway, w } = await fleet();

    expect(names((await gateway.workflowLifecycle('ingest')).startsOnSettle)).toEqual([
      'acme-notify',
      'beta-audit',
      'py-acme',
      'py-beta',
      'refresh',
    ]);
    const acme = new ProxyRunGateway(w.tenantSide, 'acme');
    expect(names((await acme.workflowLifecycle('ingest')).startsOnSettle)).toEqual([
      'acme-notify',
      'py-acme',
    ]);
    const beta = new ProxyRunGateway(w.tenantSide, 'beta');
    expect(names((await beta.workflowLifecycle('ingest')).startsOnSettle)).toEqual([
      'beta-audit',
      'py-beta',
    ]);
    // The control plane's own registrations belong to its namespace, `default`.
    const other = new ProxyRunGateway(w.tenantSide, 'default');
    expect(names((await other.workflowLifecycle('ingest')).startsOnSettle)).toEqual(['refresh']);
  });

  it("scopes the run detail's lifecycle links the same way", async () => {
    const { gateway, w } = await fleet();
    // The operator's own `refresh` applies to every namespace's runs; the tenant does not see it.
    expect((await gateway.getRunDetail('a1'))?.lifecycleSubscribers).toEqual([
      'acme-notify',
      'py-acme',
      'refresh',
    ]);

    const detail = await new ProxyRunGateway(w.tenantSide, 'acme').getRunDetail('a1');
    expect(names(detail?.workflowLifecycle?.startsOnSettle)).toEqual(['acme-notify', 'py-acme']);
    expect(detail?.lifecycleSubscribers).toEqual(['acme-notify', 'py-acme']);
  });

  it("keeps only the tenant's own runs in the run-wait links", async () => {
    const { store, w } = await fleet();
    for (const [id, namespace] of [
      ['acme-waiter', 'acme'],
      ['beta-waiter', 'beta'],
    ] as const) {
      await store.createRun({
        ...settled(id, namespace),
        workflow: 'watcher',
        status: 'suspended',
      });
      await store.putSignalWaiter({ token: runWaitToken('a1', id, 0), runId: id, seq: 0 });
    }

    const detail = await new ProxyRunGateway(w.tenantSide, 'acme').getRunDetail('a1');
    expect(detail?.awaitedBy?.map((r) => r.runId)).toEqual(['acme-waiter']);
  });

  it("strips what was read of a linked run in another tenant's namespace", async () => {
    const { store, w } = await fleet();
    await store.createRun({ ...settled('src', 'beta'), workflow: 'upload' });
    const started = lifecycleRunId('src', 'completed', 'ingest');
    await store.createRun(settled(started, 'acme'));
    await store.createRun({
      ...settled('w-acme', 'acme'),
      workflow: 'watcher',
      status: 'suspended',
    });
    await store.putSignalWaiter({
      token: runWaitToken('src', 'w-acme', 0),
      runId: 'w-acme',
      seq: 0,
    });
    const acme = new ProxyRunGateway(w.tenantSide, 'acme');

    expect((await acme.getRunDetail(started))?.triggeredBy).toEqual({
      runId: 'src',
      kind: 'completed',
    });
    expect((await acme.getRunDetail('w-acme'))?.waitsFor).toEqual([{ runId: 'src', seq: 0 }]);
  });
});

describe('lifecycle verbs against an older control plane', () => {
  /** A control plane that answers every request the way a release without these verbs does. */
  function olderControlPlane(answer: 'unsupported-code' | 'empty-ok') {
    const w = wire();
    w.controlPlaneSide.onRunRequest(async (msg) => {
      await w.controlPlaneSide.publishRunReply({
        requestId: msg.requestId,
        result:
          answer === 'unsupported-code'
            ? {
                ok: false,
                error: { message: 'unknown verb', code: 'unsupported-request' },
              }
            : { ok: true, data: undefined },
      });
    });
    return w;
  }

  it.each(['unsupported-code', 'empty-ok'] as const)(
    'fails at once with a not-supported error (%s), and remembers it for a while',
    async (answer) => {
      const w = olderControlPlane(answer);
      const proxy = new ProxyRunGateway(w.tenantSide, 'acme', 60_000);

      for (const call of [
        () => proxy.republishLifecycle({ runId: 'a1' }),
        () => proxy.workflowLifecycle('ingest'),
      ]) {
        const error = await call().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(RunGatewayError);
        expect((error as RunGatewayError).code).toBe('unsupported-request');
        expect((error as Error).message).toMatch(/not supported by this server/);
      }
      expect(w.sent.map((b) => b.kind)).toEqual(['republishLifecycle', 'workflowLifecycle']);

      await proxy.republishLifecycle({ workflow: 'ingest' }).catch(() => undefined);
      expect(w.sent).toHaveLength(2);
    },
  );

  it('answers not supported when the control plane gateway cannot republish', async () => {
    const w = wire();
    const store = new InMemoryStateStore();
    const gateway = new StoreRunGateway(store, new WorkflowEngine({ store }));
    Object.assign(gateway, { republishLifecycle: undefined, workflowLifecycle: undefined });
    new RunRequestResponder(w.controlPlaneSide, gateway, { warnWithoutVerifier: false }).start();
    const proxy = new ProxyRunGateway(w.tenantSide, 'acme', 60_000);

    for (const call of [
      () => proxy.republishLifecycle({ runId: 'a1' }),
      () => proxy.republishLifecycle({ workflow: 'ingest' }),
      () => proxy.workflowLifecycle('ingest'),
    ]) {
      const error = await call().catch((e: unknown) => e);
      expect((error as RunGatewayError).code).toBe('unsupported-request');
    }
  });
});
