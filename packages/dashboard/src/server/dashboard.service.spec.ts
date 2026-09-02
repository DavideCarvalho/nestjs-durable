import {
  type DurableTopology,
  type EngineEvent,
  type GroupHealth,
  InMemoryStateStore,
  type RunGateway,
  type RunQuery,
  type RunWaiting,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';

/** A run with just the required `WorkflowRun` fields filled in, for gateway fakes that only need an id. */
function fakeRun(id: string): WorkflowRun {
  return {
    id,
    workflow: 'wf',
    workflowVersion: '1',
    status: 'pending',
    input: undefined,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface FakeGatewayOverrides {
  record?: (call: string) => void;
  listRuns?: (query: RunQuery) => Promise<WorkflowRun[]>;
  workerHealth?: () => Promise<GroupHealth[]>;
  topology?: () => DurableTopology;
  subscribe?: (runId: string, onEvent: (event: EngineEvent) => void) => () => void;
}

/**
 * A `RunGateway` fake — every method records its call (so a test can assert routing) and returns
 * `null`/`[]` by default; `overrides` swaps in the return value a given test needs.
 */
function fakeGateway(overrides: FakeGatewayOverrides): RunGateway {
  const record = overrides.record ?? (() => {});
  return {
    async listRuns(query) {
      record('listRuns');
      return overrides.listRuns ? overrides.listRuns(query) : [];
    },
    async runFacets() {
      record('runFacets');
      return [];
    },
    async runValueFacets() {
      record('runValueFacets');
      return [];
    },
    async waitingFor(_runIds): Promise<Record<string, RunWaiting>> {
      record('waitingFor');
      return {};
    },
    async workerHealth() {
      record('workerHealth');
      return overrides.workerHealth ? overrides.workerHealth() : [];
    },
    topology() {
      record('topology');
      return overrides.topology ? overrides.topology() : { role: 'control-plane' };
    },
    async getRunDetail(runId) {
      record('getRunDetail');
      return null;
    },
    async retry(runId) {
      record('retry');
      return null;
    },
    async cancel(runId, opts) {
      record(`cancel:${JSON.stringify(opts)}`);
      return null;
    },
    async continue(runId) {
      record('continue');
      return null;
    },
    async redispatchPending(runId) {
      record('redispatchPending');
      return null;
    },
    async retryWithInput(runId, input) {
      record('retryWithInput');
      return null;
    },
    subscribe: overrides.subscribe ?? (() => () => {}),
  };
}

describe('DashboardService', () => {
  it('routes run-ops through the gateway (tenant shape: no store/engine)', async () => {
    const calls: string[] = [];
    const gateway = fakeGateway({ record: (call) => calls.push(call) });
    const service = new DashboardService(gateway); // store/engine undefined

    await service.listRuns({});
    await service.getRunDetail('r1');
    await service.retry('r1');
    await service.cancel('r1', { compensate: true });
    await service.continue('r1');
    await service.redispatch('r1');
    await service.retryWithInput('r1', { fixed: true });
    await service.workerHealth();

    expect(calls).toEqual([
      'listRuns',
      'getRunDetail',
      'retry',
      'cancel:{"compensate":true}',
      'continue',
      'redispatchPending',
      'retryWithInput',
      'workerHealth',
    ]);
  });

  it('topology routes through the gateway (works on a tenant, reports role + partition)', () => {
    const service = new DashboardService(
      fakeGateway({ topology: () => ({ role: 'tenant', tenant: 'acme' }) }),
    );
    // No store/engine (tenant shape) and it still answers — the gateway knows its own topology.
    expect(service.topology()).toEqual({ role: 'tenant', tenant: 'acme' });
  });

  it('workerHealth routes through the gateway (works on a tenant, scoped by the operator)', async () => {
    const scoped: GroupHealth[] = [{ group: 'pipeline@acme', depth: 3, liveWorkers: [] }];
    const service = new DashboardService(fakeGateway({ workerHealth: async () => scoped }));

    // No store/engine (tenant shape) and it still resolves — the gateway (a ProxyRunGateway in
    // production) answers with the operator's tenant-scoped groups instead of throwing.
    await expect(service.workerHealth()).resolves.toEqual(scoped);
  });

  it('bulk goes through the gateway, scoped and capped', async () => {
    const gateway = fakeGateway({ listRuns: async () => [fakeRun('a'), fakeRun('b')] });
    const service = new DashboardService(gateway);

    const res = await service.bulk('cancel', { status: 'dead' }, { compensate: true });
    expect(res).toEqual({ matched: 2, applied: 2 });
  });

  it('operator-only ops throw a clear error without the control plane', async () => {
    const service = new DashboardService(fakeGateway({}));

    await expect(service.metrics()).rejects.toThrow(/control plane/);
    await expect(service.getEvent('r1', 'k')).rejects.toThrow(/control plane/);
    await expect(service.update('r1', 'u', {})).rejects.toThrow(/control plane/);
    await expect(service.deliverWebhook('tok', {})).rejects.toThrow(/control plane/);
  });

  it("streamRun emits the target run's events via gateway.subscribe", () => {
    let handler: ((event: EngineEvent) => void) | undefined;
    const gateway = fakeGateway({
      subscribe: (runId, onEvent) => {
        handler = onEvent;
        return () => {};
      },
    });
    const service = new DashboardService(gateway);

    const seen: EngineEvent[] = [];
    service.streamRun('r1').subscribe((message) => seen.push(message.data));

    // ProxyRunGateway/StoreRunGateway both filter by runId before invoking the handler — the
    // dashboard trusts the gateway's filter and just wires events through.
    handler?.({ type: 'run.started', runId: 'r1', at: new Date() });

    expect(seen.map((event) => event.runId)).toContain('r1');
  });

  it('operator-only ops work when store+engine are present (control-plane shape)', async () => {
    // Real, empty store + engine (no runs, no registered workflows, no worker groups) — the
    // simplest way to prove the control-plane path still works without hand-rolling a fake for
    // `StateStore` (15+ methods) or subclassing `WorkflowEngine` (private fields disallow a
    // structurally-typed object literal).
    const store = new InMemoryStateStore();
    const engine = new WorkflowEngine({ store });
    const service = new DashboardService(fakeGateway({}), store, engine);

    await expect(service.metrics()).resolves.toContain('durable_pending_runs 0');
  });
});
