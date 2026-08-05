import type { RunGateway, RunQuery, RunWaiting } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';
import { DurableApiController } from './durable-api.controller.js';

/**
 * Controller → service → gateway, wired for real (no store/engine — the tenant shape), with the one
 * `RunGateway` method these paths reach recorded. Asserting on the query the GATEWAY receives is what
 * makes these tests about the filter surviving the whole trip, not just about parameter decorators.
 */
function recordingConsole(): { controller: DurableApiController; queries: RunQuery[] } {
  const queries: RunQuery[] = [];
  const gateway: RunGateway = {
    async listRuns(query) {
      queries.push(query);
      return [];
    },
    async waitingFor(): Promise<Record<string, RunWaiting>> {
      return {};
    },
    async workerHealth() {
      return [];
    },
    topology() {
      return { role: 'control-plane' };
    },
    async getRunDetail() {
      return null;
    },
    async retry() {
      return null;
    },
    async cancel() {
      return null;
    },
    async continue() {
      return null;
    },
    async redispatchPending() {
      return null;
    },
    async retryWithInput() {
      return null;
    },
    subscribe: () => () => {},
  };
  return { controller: new DurableApiController(new DashboardService(gateway)), queries };
}

describe('DurableApiController: run-list filters', () => {
  it('narrows by namespace and origin when the operator asks', async () => {
    const { controller, queries } = recordingConsole();

    await controller.runs(undefined, undefined, undefined, undefined, 'acme', '@dudousxd/agent');

    expect(queries[0]?.namespace).toBe('acme');
    expect(queries[0]?.origin).toBe('@dudousxd/agent');
  });

  it('leaves BOTH undefined when no param is sent — the default is every tenant, every origin', async () => {
    // Core is explicit that read paths are not namespace-scoped. If this ever defaulted to a single
    // tenant, every existing operator would silently stop seeing the other tenants' runs.
    const { controller, queries } = recordingConsole();

    await controller.runs();

    expect(queries[0]?.namespace).toBeUndefined();
    expect(queries[0]?.origin).toBeUndefined();
  });

  it('treats a blank param as absent, not as a tenant named ""', async () => {
    // `?namespace=` is what a cleared filter box sends. Passing '' through would be an exact match
    // against a namespace nothing has — a console that goes empty for no visible reason.
    const { controller, queries } = recordingConsole();

    await controller.runs(undefined, undefined, undefined, undefined, '', '');

    expect(queries[0]?.namespace).toBeUndefined();
    expect(queries[0]?.origin).toBeUndefined();
  });

  it('keeps the existing predicates working alongside the new ones', async () => {
    const { controller, queries } = recordingConsole();

    await controller.runs('dead', 'checkout', 'tier:pro', 'amount:gte:200', 'acme');

    expect(queries[0]).toMatchObject({
      status: 'dead',
      workflow: 'checkout',
      tag: 'tier:pro',
      namespace: 'acme',
    });
    expect(queries[0]?.attributes).toEqual([{ key: 'amount', op: 'gte', value: 200 }]);
  });
});

describe('DurableApiController: bulk scoping', () => {
  it('carries namespace and origin into the set a bulk action acts on', async () => {
    // A bulk retry/cancel that dropped these would act on runs from tenants and libraries the
    // operator never had on screen.
    const { controller, queries } = recordingConsole();

    await controller.bulk(
      'cancel',
      'dead',
      undefined,
      undefined,
      undefined,
      'true',
      'acme',
      '@dudousxd/agent',
    );

    expect(queries[0]).toMatchObject({
      status: 'dead',
      namespace: 'acme',
      origin: '@dudousxd/agent',
    });
  });

  it('treats blank bulk params as absent too', async () => {
    const { controller, queries } = recordingConsole();

    await controller.bulk('retry', undefined, undefined, undefined, undefined, undefined, '', '');

    expect(queries[0]?.namespace).toBeUndefined();
    expect(queries[0]?.origin).toBeUndefined();
  });
});
