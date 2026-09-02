import {
  type StateStore,
  type StepCheckpoint,
  WorkflowEngine,
  type WorkflowRun,
} from '@dudousxd/nestjs-durable-core';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * A freshly provisioned, empty {@link StateStore} plus a `cleanup` to release its resources (close
 * the connection, drop the schema, etc.). The conformance suite asks for one before each test so
 * every case starts from a clean slate — exactly like the per-store specs that build a `:memory:` DB.
 */
export interface StateStoreContext {
  store: StateStore;
  cleanup: () => Promise<void>;
  /**
   * Whether the store's optional `transaction` can run an ASYNC work callback. Defaults to `true`.
   * Set `false` only for a driver that genuinely can't — e.g. Drizzle on the SYNCHRONOUS
   * `better-sqlite3` driver, whose `transaction()` rejects a promise-returning callback ("Transaction
   * function cannot return a promise"). The same Drizzle adapter on an async driver (libSQL) works,
   * and the contract still asserts `transaction` for every other store, so this never hides drift.
   */
  supportsAsyncTransaction?: boolean;
  /**
   * Whether the store can filter `listRuns({ tag })`. Defaults to `true`. Set `false` ONLY for
   * Prisma-on-SQLite: the Prisma adapter filters tags with the `array_contains` JSON predicate, which
   * Prisma supports on its real targets (Postgres + MySQL) but NOT on SQLite. SQLite is only the
   * adapter's local TEST database, so the tag case is skipped there; every other store (and Prisma on
   * a real engine) still asserts it, so this doesn't hide drift in the supported configurations.
   */
  supportsTagFilter?: boolean;
}

/** Builds a fresh, empty store for one test. Called once per `it` (in `beforeEach`). */
export type StateStoreFactory = () => Promise<StateStoreContext>;

/**
 * Thrown by a {@link StateStoreFactory} to SKIP the contract for an unavailable backend instead of
 * failing it — e.g. a testcontainers DB spec when Docker isn't running. Every contract case catches
 * it, logs once, and returns (a no-op pass), so `pnpm test:db` is green-with-skips off a dev box
 * without Docker rather than red.
 */
export class StateStoreUnavailableError extends Error {
  readonly isStateStoreUnavailable = true;
  constructor(message: string) {
    super(message);
    this.name = 'StateStoreUnavailableError';
  }
}

function isUnavailable(err: unknown): err is StateStoreUnavailableError {
  return !!err && typeof err === 'object' && 'isStateStoreUnavailable' in err;
}

const at = new Date('2026-06-11T00:00:00.000Z');

const run = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: 'r1',
  workflow: 'checkout',
  workflowVersion: '1',
  status: 'running',
  input: { orderId: 'o1' },
  createdAt: at,
  updatedAt: at,
  ...over,
});

const checkpoint = (over: Partial<StepCheckpoint> = {}): StepCheckpoint => ({
  runId: 'r1',
  seq: 0,
  name: 'reserve',
  kind: 'local',
  stepId: 'r1:0',
  status: 'completed',
  output: { ok: true },
  attempts: 1,
  enqueuedAt: at,
  startedAt: at,
  finishedAt: at,
  ...over,
});

/**
 * The SHARED behavioral contract every `StateStore` must satisfy — in-memory and each ORM adapter
 * alike. Registered as a vitest `describe`; pass a `name` and a {@link StateStoreFactory} that builds
 * a fresh, empty store. The same assertions run against SQLite/in-memory under `pnpm test` and
 * against real Postgres/MySQL (via testcontainers) under `pnpm test:db`, so any drift between an
 * adapter and the canonical (in-memory) semantics — especially the search-attribute side-table
 * pushdown, which is implemented per-store — fails here instead of silently in production.
 *
 * Each adapter's own spec keeps its dialect-specific tests (DDL/longtext/EXISTS-SQL/JSON-tolerance);
 * this suite owns the cross-store behavior so those never drift apart.
 */
export function runStateStoreContract(name: string, makeStore: StateStoreFactory): void {
  describe(`StateStore contract: ${name}`, () => {
    let store: StateStore;
    let cleanup: (() => Promise<void>) | undefined;
    let supportsAsyncTransaction = true;
    let supportsTagFilter = true;
    let skipReason: string | undefined;
    let loggedSkip = false;

    beforeEach(async () => {
      try {
        const ctx = await makeStore();
        store = ctx.store;
        cleanup = ctx.cleanup;
        supportsAsyncTransaction = ctx.supportsAsyncTransaction ?? true;
        supportsTagFilter = ctx.supportsTagFilter ?? true;
        skipReason = undefined;
      } catch (err) {
        if (isUnavailable(err)) {
          // Backend unavailable (e.g. no Docker for a testcontainers spec): skip — don't fail.
          skipReason = err.message;
          if (!loggedSkip) {
            console.warn(`[state-store-contract] SKIPPING "${name}": ${skipReason}`);
            loggedSkip = true;
          }
          return;
        }
        throw err;
      }
      return async () => {
        await cleanup?.();
      };
    });

    /** Register a contract case that no-ops (passes) when the backend was reported unavailable. */
    const t = (label: string, fn: () => Promise<void>): void => {
      it(label, async () => {
        if (skipReason) return;
        await fn();
      });
    };

    // ---- create / get / update --------------------------------------------------------------

    t('creates a run and reads it back with its JSON input', async () => {
      await store.createRun(run());
      const loaded = await store.getRun('r1');
      expect(loaded?.workflow).toBe('checkout');
      expect(loaded?.input).toEqual({ orderId: 'o1' });
    });

    t('returns null for a missing run', async () => {
      expect(await store.getRun('nope')).toBeNull();
    });

    t('updates a run (status/output) and round-trips recoveryAttempts + dead status', async () => {
      await store.createRun(run({ recoveryAttempts: 3 }));
      await store.updateRun('r1', {
        status: 'completed',
        output: { total: 42 },
        updatedAt: at,
      });
      const done = await store.getRun('r1');
      expect(done?.status).toBe('completed');
      expect(done?.output).toEqual({ total: 42 });
      expect(done?.recoveryAttempts).toBe(3);

      await store.updateRun('r1', { status: 'dead', recoveryAttempts: 4 });
      const dead = await store.getRun('r1');
      expect(dead?.status).toBe('dead');
      expect(dead?.recoveryAttempts).toBe(4);
    });

    t('round-trips a run dispatch priority', async () => {
      await store.createRun(run({ id: 'withprio', priority: 7 }));
      await store.createRun(run({ id: 'noprio' }));
      expect((await store.getRun('withprio'))?.priority).toBe(7);
      expect((await store.getRun('noprio'))?.priority).toBeUndefined();
    });

    t('deleteRun removes the run and all its rows (checkpoints, waiters, attributes)', async () => {
      await store.createRun(run({ searchAttributes: { tier: 'pro' } }));
      await store.saveCheckpoint(checkpoint());
      await store.putSignalWaiter({ token: 'approve-r1', runId: 'r1', seq: 0 });

      await store.deleteRun('r1');

      // The run and every child row are gone — not merely marked terminal.
      expect(await store.getRun('r1')).toBeNull();
      expect(await store.listCheckpoints('r1')).toEqual([]);
      expect(await store.listSignalWaiters('approve-')).toEqual([]);
      // The normalized attribute side-table no longer matches it.
      expect(
        await store.listRuns({
          attributes: [{ key: 'tier', op: 'eq', value: 'pro' }],
        }),
      ).toEqual([]);
    });

    t('deleteRun is a no-op for a missing run', async () => {
      await expect(store.deleteRun('nope')).resolves.toBeUndefined();
    });

    t(
      'updateRun maps every patchable field — clears error and patches tags/lockedBy/input/timers',
      async () => {
        // Guards against per-adapter patch-whitelist drift: a store that maps only a subset of fields
        // (or ignores `undefined` instead of clearing) would silently no-op these and fail here.
        await store.createRun(
          run({ status: 'failed', error: { message: 'boom' }, tags: ['old'], lockedBy: 'owner-1' }),
        );
        await store.updateRun('r1', {
          status: 'completed',
          output: { ok: true },
          error: undefined, // completion CLEARS the prior error
          input: { orderId: 'o2' },
          tags: ['x', 'y'],
          lockedBy: 'owner-2',
          wakeAt: 123_456,
          lockedUntil: 222_222,
          updatedAt: at,
        });
        const r = await store.getRun('r1');
        expect(r?.status).toBe('completed');
        expect(r?.output).toEqual({ ok: true });
        expect(r?.error).toBeUndefined();
        expect(r?.input).toEqual({ orderId: 'o2' });
        expect(r?.tags).toEqual(['x', 'y']);
        expect(r?.lockedBy).toBe('owner-2');
        expect(r?.wakeAt).toBe(123_456);
        expect(r?.lockedUntil).toBe(222_222);

        // The multi-instance REMOTE-decision marker must round-trip AND clear: the engine sets it
        // when it suspends on an awaited turn and clears it (`undefined`) when the decision lands. An
        // adapter that drops it on read, or ignores `undefined` instead of writing NULL, would silently
        // break completeRemoteDecision (it reads back the stale/absent marker and discards the decision).
        await store.updateRun('r1', { awaitingDecisionTaskId: 'turn-7' });
        expect((await store.getRun('r1'))?.awaitingDecisionTaskId).toBe('turn-7');
        await store.updateRun('r1', { awaitingDecisionTaskId: undefined });
        expect((await store.getRun('r1'))?.awaitingDecisionTaskId).toBeUndefined();
      },
    );

    // ---- checkpoints ------------------------------------------------------------------------

    t(
      'upserts checkpoints, reads them by (runId, seq), and lists them ordered by seq',
      async () => {
        await store.createRun(run());
        await store.saveCheckpoint(checkpoint());
        await store.saveCheckpoint(
          checkpoint({ seq: 1, name: 'charge', output: { chargeId: 'ch_1' } }),
        );
        // Re-save seq 0 with a new output — upsert, not a duplicate row.
        await store.saveCheckpoint(checkpoint({ output: { ok: true, again: true } }));

        expect((await store.getCheckpoint('r1', 0))?.output).toEqual({ ok: true, again: true });
        expect((await store.getCheckpoint('r1', 1))?.name).toBe('charge');
        const list = await store.listCheckpoints('r1');
        expect(list.map((c) => c.seq)).toEqual([0, 1]);
      },
    );

    t(
      'getLatestCheckpointByName returns the highest-seq match (and undefined for none)',
      async () => {
        await store.createRun(run());
        await store.saveCheckpoint(
          checkpoint({ seq: 0, name: 'event:progress', output: { pct: 10 } }),
        );
        await store.saveCheckpoint(checkpoint({ seq: 1, name: 'charge', output: { id: 'c1' } }));
        await store.saveCheckpoint(
          checkpoint({ seq: 2, name: 'event:progress', output: { pct: 50 } }),
        );
        await store.saveCheckpoint(
          checkpoint({ seq: 3, name: 'event:progress', output: { pct: 90 } }),
        );

        // Optional on the interface (the engine has a fallback), but a conformant store MUST provide
        // it — assert presence, then exercise the fast path.
        const getLatestCheckpointByName = store.getLatestCheckpointByName;
        expect(getLatestCheckpointByName).toBeDefined();
        if (!getLatestCheckpointByName) return;

        const latest = await getLatestCheckpointByName.call(store, 'r1', 'event:progress');
        expect(latest?.seq).toBe(3);
        expect(latest?.output).toEqual({ pct: 90 });
        expect(await getLatestCheckpointByName.call(store, 'r1', 'event:missing')).toBeUndefined();
      },
    );

    t(
      'listCheckpointsByNamePrefix returns prefix matches ordered by seq (empty => none)',
      async () => {
        await store.createRun(run());
        await store.saveCheckpoint(checkpoint({ seq: 0, name: 'reserve' }));
        await store.saveCheckpoint(checkpoint({ seq: 1, name: 'spawn:0', output: 'child-a' }));
        await store.saveCheckpoint(checkpoint({ seq: 2, name: 'signal:child:c2' }));
        await store.saveCheckpoint(checkpoint({ seq: 3, name: 'event:progress' }));
        await store.saveCheckpoint(checkpoint({ seq: 4, name: 'spawn:1', output: 'child-b' }));

        // Optional on the interface (the engine has a fallback), but a conformant store MUST provide
        // it — assert presence, then exercise the fast path.
        const listCheckpointsByNamePrefix = store.listCheckpointsByNamePrefix;
        expect(listCheckpointsByNamePrefix).toBeDefined();
        if (!listCheckpointsByNamePrefix) return;

        const matches = await listCheckpointsByNamePrefix.call(store, 'r1', [
          'signal:child:',
          'spawn:',
        ]);
        expect(matches.map((c) => c.name)).toEqual(['spawn:0', 'signal:child:c2', 'spawn:1']);
        expect(await listCheckpointsByNamePrefix.call(store, 'r1', [])).toEqual([]);
      },
    );

    t('round-trips checkpoint events and reads back a missing checkpoint as null', async () => {
      await store.createRun(run());
      await store.saveCheckpoint(
        checkpoint({
          events: [{ at: 1, level: 'error', message: 'p-3 failed', name: 'p-3', status: 'failed' }],
        }),
      );
      expect((await store.getCheckpoint('r1', 0))?.events).toEqual([
        { at: 1, level: 'error', message: 'p-3 failed', name: 'p-3', status: 'failed' },
      ]);
      expect(await store.getCheckpoint('r1', 99)).toBeNull();
    });

    // ---- recovery / dispatch / timer scans --------------------------------------------------

    t('lists incomplete runs, pending runs (FIFO), and due timers', async () => {
      await store.createRun(run({ id: 'running1', status: 'running' }));
      await store.createRun(run({ id: 'suspended1', status: 'suspended', wakeAt: 5_000 }));
      await store.createRun(run({ id: 'done1', status: 'completed' }));
      await store.createRun(
        run({ id: 'pending2', status: 'pending', createdAt: new Date('2026-06-11T00:00:02.000Z') }),
      );
      await store.createRun(
        run({ id: 'pending1', status: 'pending', createdAt: new Date('2026-06-11T00:00:01.000Z') }),
      );

      expect((await store.listIncompleteRuns()).map((r) => r.id)).toEqual(['running1']);
      // FIFO by createdAt.
      expect((await store.listPendingRuns(10)).map((r) => r.id)).toEqual(['pending1', 'pending2']);
      expect((await store.listPendingRuns(1)).map((r) => r.id)).toEqual(['pending1']);
      expect((await store.listDueTimers(10_000)).map((r) => r.id)).toEqual(['suspended1']);
      expect(await store.listDueTimers(1_000)).toHaveLength(0);
    });

    t('keeps a worker inside its own namespace on every path that picks work up', async () => {
      // The boundary `WorkflowRun.namespace` documents: "A worker only picks up /
      // recovers / resumes-timers-for / times-out runs in its own namespace."
      //
      // This case exists because that sentence was true of exactly one adapter. The
      // other three did not declare the `namespace` parameter at all — and TypeScript
      // lets an implementation take fewer parameters than the interface promises, so
      // three stores silently ignored the argument and still satisfied `StateStore`.
      // A worker serving one tenant listed, recovered and — through `sweepTimeouts`,
      // which selects its cancellation candidates with `listRuns` — CANCELLED another
      // tenant's runs. The last of those is a write, which is why this is asserted on
      // all four paths rather than on the two that name `namespace` in their signature.
      await store.createRun(run({ id: 'a-pending', status: 'pending', namespace: 'alpha' }));
      await store.createRun(run({ id: 'b-pending', status: 'pending', namespace: 'beta' }));
      await store.createRun(run({ id: 'a-running', status: 'running', namespace: 'alpha' }));
      await store.createRun(run({ id: 'b-running', status: 'running', namespace: 'beta' }));
      await store.createRun(
        run({ id: 'a-timer', status: 'suspended', wakeAt: 5_000, namespace: 'alpha' }),
      );
      await store.createRun(
        run({ id: 'b-timer', status: 'suspended', wakeAt: 5_000, namespace: 'beta' }),
      );

      expect((await store.listPendingRuns(10, 'alpha')).map((r) => r.id)).toEqual(['a-pending']);
      expect((await store.listIncompleteRuns('alpha')).map((r) => r.id)).toEqual(['a-running']);
      expect((await store.listDueTimers(10_000, 'alpha')).map((r) => r.id)).toEqual(['a-timer']);
      expect(
        (await store.listRuns({ namespace: 'alpha', status: 'running' })).map((r) => r.id),
      ).toEqual(['a-running']);

      // Foreign runs must not eat the FIFO budget either. Asking for one row while
      // `beta` holds the oldest pending run has to return `alpha`'s, not nothing:
      // a store that filtered AFTER applying the limit would answer with an empty
      // page and look exactly like an idle tenant.
      expect((await store.listPendingRuns(1, 'alpha')).map((r) => r.id)).toEqual(['a-pending']);

      // `undefined` is NOT "namespace is null" — it is the operator view, every
      // tenant at once. A store that read it as a null predicate would pass every
      // single-tenant test written above and hide every run in a deployment that
      // actually sets `DURABLE_TENANT`.
      expect((await store.listPendingRuns(10)).map((r) => r.id).sort()).toEqual([
        'a-pending',
        'b-pending',
      ]);
      expect((await store.listIncompleteRuns()).map((r) => r.id).sort()).toEqual([
        'a-running',
        'b-running',
      ]);
      expect((await store.listDueTimers(10_000)).map((r) => r.id).sort()).toEqual([
        'a-timer',
        'b-timer',
      ]);
    });

    // ---- lease / lock -----------------------------------------------------------------------

    t('tryLockRun is atomic and respects lease expiry', async () => {
      await store.createRun(run({ id: 'r1' }));
      expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
      // B can't take it while A's lease is live.
      expect(await store.tryLockRun('r1', 'B', 3_000, 1_500)).toBe(false);
      // Once A's lease (2_000) has passed, B reclaims it.
      expect(await store.tryLockRun('r1', 'B', 4_000, 2_500)).toBe(true);
      // Release lets anyone re-acquire immediately.
      await store.releaseRunLock('r1');
      expect(await store.tryLockRun('r1', 'C', 9_000, 2_600)).toBe(true);
    });

    t('renewRunLock only succeeds for the current owner', async () => {
      await store.createRun(run({ id: 'r1' }));
      expect(await store.tryLockRun('r1', 'A', 2_000, 1_000)).toBe(true);
      // The holder heartbeats and keeps the lease.
      expect(await store.renewRunLock('r1', 'A', 5_000)).toBe(true);
      // A different instance can't renew a lease it doesn't hold.
      expect(await store.renewRunLock('r1', 'B', 9_000)).toBe(false);
      // And the renewed lease is honored: B still can't steal it before it expires.
      expect(await store.tryLockRun('r1', 'B', 6_000, 4_000)).toBe(false);
    });

    // ---- list filters: status / statuses / tag / origin --------------------------------------

    t('filters listRuns by workflow and by status', async () => {
      await store.createRun(run({ id: 'a', workflow: 'checkout', status: 'running' }));
      await store.createRun(run({ id: 'b', workflow: 'refund', status: 'running' }));
      await store.createRun(run({ id: 'c', workflow: 'checkout', status: 'completed' }));

      expect((await store.listRuns({ workflow: 'checkout' })).map((r) => r.id).sort()).toEqual([
        'a',
        'c',
      ]);
      expect((await store.listRuns({ status: 'running' })).map((r) => r.id).sort()).toEqual([
        'a',
        'b',
      ]);
      expect(
        (await store.listRuns({ workflow: 'checkout', status: 'running' })).map((r) => r.id),
      ).toEqual(['a']);
    });

    t('filters listRuns by a status set (status IN ...) for singleton admission', async () => {
      await store.createRun(run({ id: 'a', status: 'running' }));
      await store.createRun(run({ id: 'b', status: 'suspended' }));
      await store.createRun(run({ id: 'c', status: 'completed' }));
      await store.createRun(run({ id: 'd', status: 'pending' }));

      expect(
        (await store.listRuns({ statuses: ['running', 'suspended'] })).map((r) => r.id).sort(),
      ).toEqual(['a', 'b']);
      // Single + set are ANDed (the narrower set wins).
      expect(
        (await store.listRuns({ status: 'running', statuses: ['running', 'suspended'] })).map(
          (r) => r.id,
        ),
      ).toEqual(['a']);
      // Empty set matches nothing.
      expect(await store.listRuns({ statuses: [] })).toHaveLength(0);
    });

    t('filters listRuns by an exact tag (no substring match)', async () => {
      if (!supportsTagFilter) return; // Prisma + SQLite: array_contains is unsupported there (see flag doc)
      await store.createRun(run({ id: 'a', tags: ['etl', 'critical'] }));
      await store.createRun(run({ id: 'b', tags: ['etl-foo'] }));
      await store.createRun(run({ id: 'c' })); // no tags

      expect((await store.getRun('a'))?.tags).toEqual(['etl', 'critical']);
      expect((await store.listRuns({ tag: 'etl' })).map((r) => r.id)).toEqual(['a']);
      expect((await store.listRuns({ tag: 'etl-foo' })).map((r) => r.id)).toEqual(['b']);
      expect(await store.listRuns({ tag: 'nope' })).toHaveLength(0);
    });

    t(
      'round-trips a run origin and filters listRuns by it, never matching an absent one',
      async () => {
        // `origin` (which library registered the workflow) is derived at registration, never declared,
        // so ABSENCE is a first-class value: `undefined` means UNKNOWN — a row written before the
        // column existed, a `registerRemote`, convention routing, an unresolvable package. It must
        // survive the round trip as `undefined` rather than as any plausible-looking stand-in, which a
        // real registration would then be indistinguishable from.
        await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-catalog-pipeline' }));
        await store.createRun(run({ id: 'b', origin: '@dudousxd/nestjs-agent' }));
        await store.createRun(run({ id: 'c' })); // unattributed — unknown origin

        expect((await store.getRun('a'))?.origin).toBe('@dudousxd/nestjs-catalog-pipeline');
        expect((await store.getRun('c'))?.origin).toBeUndefined();

        // `RunQuery.origin` is plain equality, so the unattributed run matches NO origin value — it is
        // excluded here exactly as `b` is, and is never folded into a bucket to make a facet look
        // complete. A store that widened this to `= x OR IS NULL` would return `c` and fail.
        expect(
          (await store.listRuns({ origin: '@dudousxd/nestjs-catalog-pipeline' })).map((r) => r.id),
        ).toEqual(['a']);
        // Nor does it answer to a name invented for it.
        expect(await store.listRuns({ origin: 'unknown' })).toEqual([]);
        // Which is why "all origins" has to stay the default view: with the filter off — and only
        // then — the unattributed run is reachable.
        expect((await store.listRuns({})).map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
      },
    );

    t(
      'selects the UNATTRIBUTED runs when `origin` is null — the one thing a value cannot',
      async () => {
        // The console needs an "unknown origin" facet, and the same absence that makes `origin` match
        // no value makes it unfilterable by one. `null` asks for `origin IS NULL` instead, which is what
        // lets that facet page server-side rather than by holding every run in the browser.
        await store.createRun(run({ id: 'a', origin: '@dudousxd/nestjs-agent' }));
        await store.createRun(run({ id: 'b' }));
        await store.createRun(run({ id: 'c' }));

        expect((await store.listRuns({ origin: null })).map((r) => r.id).sort()).toEqual([
          'b',
          'c',
        ]);
        // And it stays ANDed with the other predicates rather than replacing them.
        await store.createRun(run({ id: 'd', status: 'dead' }));
        expect((await store.listRuns({ origin: null, status: 'dead' })).map((r) => r.id)).toEqual([
          'd',
        ]);
      },
    );

    t('counts runs by (status, origin) without returning them', async () => {
      // The aggregate behind a console's chips. It exists so the run LIST can be paged: the page
      // bounds what is rendered, this bounds nothing — so a store that quietly applied the same limit
      // would report the page size as the deployment's totals.
      if (!store.runFacets) return; // optional on the port; every SQL adapter implements it
      await store.createRun(run({ id: 'a', status: 'completed', origin: 'pkg-a' }));
      await store.createRun(run({ id: 'b', status: 'completed', origin: 'pkg-a' }));
      await store.createRun(run({ id: 'c', status: 'failed', origin: 'pkg-b' }));
      await store.createRun(run({ id: 'd', status: 'failed' })); // unattributed
      await store.createRun(run({ id: 'e', status: 'failed' })); // unattributed

      const facets = await store.runFacets({});

      expect(facets).toContainEqual({ status: 'completed', origin: 'pkg-a', count: 2 });
      expect(facets).toContainEqual({ status: 'failed', origin: 'pkg-b', count: 1 });
      // Runs with no origin are a real, countable cell here — `null`, not a stand-in name.
      expect(facets).toContainEqual({ status: 'failed', origin: null, count: 2 });
      expect(facets.reduce((n, f) => n + f.count, 0)).toBe(5);
    });

    t('narrows runFacets on the same predicates listRuns pages', async () => {
      // A facet count that did not obey the tenant/tag the operator has typed would label the page
      // with a number taken over a different set.
      if (!store.runFacets) return;
      await store.createRun(run({ id: 'a', status: 'failed', namespace: 'acme' }));
      await store.createRun(run({ id: 'b', status: 'failed', namespace: 'globex' }));

      expect(await store.runFacets({ namespace: 'acme' })).toEqual([
        { status: 'failed', origin: null, count: 1 },
      ]);
    });

    // ---- multi-value predicates (the console's multi-selects) -------------------------------

    t('matches ANY of a set of statuses, workflows, tenants or origins', async () => {
      // One control, several values. Each plural field ORs within itself and ANDs with the rest, so
      // an operator comparing two tenants sees both without issuing two queries.
      await store.createRun(run({ id: 'a', status: 'failed', namespace: 'acme', workflow: 'wa' }));
      await store.createRun(run({ id: 'b', status: 'dead', namespace: 'globex', workflow: 'wb' }));
      await store.createRun(
        run({ id: 'c', status: 'completed', namespace: 'initech', workflow: 'wc' }),
      );

      expect(
        (await store.listRuns({ statuses: ['failed', 'dead'] })).map((r) => r.id).sort(),
      ).toEqual(['a', 'b']);
      expect(
        (await store.listRuns({ namespaces: ['acme', 'globex'] })).map((r) => r.id).sort(),
      ).toEqual(['a', 'b']);
      expect((await store.listRuns({ workflows: ['wa', 'wc'] })).map((r) => r.id).sort()).toEqual([
        'a',
        'c',
      ]);
    });

    t('carries the absent-origin bucket INSIDE a set of origins', async () => {
      // "This package plus the runs nothing claims" — a view the single `origin` cannot express at
      // all, and the reason `null` is a member of the set rather than a separate flag.
      await store.createRun(run({ id: 'a', origin: 'pkg-a' }));
      await store.createRun(run({ id: 'b', origin: 'pkg-b' }));
      await store.createRun(run({ id: 'c' }));

      expect((await store.listRuns({ origins: ['pkg-a', null] })).map((r) => r.id).sort()).toEqual([
        'a',
        'c',
      ]);
      expect(
        (await store.listRuns({ origins: ['pkg-a', 'pkg-b'] })).map((r) => r.id).sort(),
      ).toEqual(['a', 'b']);
    });

    t('ANDs a plural predicate with everything else, and matches nothing when empty', async () => {
      // An empty set is a real answer — "none of these" — and must not widen to every run, which is
      // what dropping the clause would do.
      await store.createRun(run({ id: 'a', status: 'failed', namespace: 'acme' }));
      await store.createRun(run({ id: 'b', status: 'dead', namespace: 'acme' }));

      expect(
        (await store.listRuns({ namespaces: ['acme'], statuses: ['dead'] })).map((r) => r.id),
      ).toEqual(['b']);
      expect(await store.listRuns({ namespaces: [] })).toEqual([]);
      expect(await store.listRuns({ statuses: [] })).toEqual([]);
      expect(await store.listRuns({ origins: [] })).toEqual([]);
    });

    t('matches runs carrying ANY of a set of tags', async () => {
      if (!supportsTagFilter) return;
      // A run holds a SET of tags, so the useful multi-value question is membership in the union —
      // asking for the intersection would return nothing for tags that never co-occur.
      await store.createRun(run({ id: 'a', tags: ['etl'] }));
      await store.createRun(run({ id: 'b', tags: ['nightly', 'batch'] }));
      await store.createRun(run({ id: 'c', tags: ['adhoc'] }));

      expect((await store.listRuns({ tags: ['etl', 'nightly'] })).map((r) => r.id).sort()).toEqual([
        'a',
        'b',
      ]);
      expect(await store.listRuns({ tags: [] })).toEqual([]);
    });

    t('matches a search attribute against a SET of values (the `in` predicate)', async () => {
      // Two `eq` predicates on one key are ANDed like every other pair, and no run has one attribute
      // with two values — so a multi-select over attribute values needs its own operator.
      await store.createRun(run({ id: 'a', searchAttributes: { tier: 'pro' } }));
      await store.createRun(run({ id: 'b', searchAttributes: { tier: 'enterprise' } }));
      await store.createRun(run({ id: 'c', searchAttributes: { tier: 'free' } }));
      await store.createRun(run({ id: 'd', searchAttributes: { amount: 200 } }));

      const inSet = await store.listRuns({
        attributes: [{ key: 'tier', op: 'in', values: ['pro', 'enterprise'] }],
      });
      expect(inSet.map((r) => r.id).sort()).toEqual(['a', 'b']);

      // Mixed operand types land in different typed columns and still OR together.
      const mixed = await store.listRuns({
        attributes: [{ key: 'amount', op: 'in', values: [200, 'none'] }],
      });
      expect(mixed.map((r) => r.id)).toEqual(['d']);

      // Empty set matches nothing, and a run missing the key never matches.
      expect(await store.listRuns({ attributes: [{ key: 'tier', op: 'in', values: [] }] })).toEqual(
        [],
      );
      expect(
        (await store.listRuns({ attributes: [{ key: 'tier', op: 'in', values: ['pro'] }] })).map(
          (r) => r.id,
        ),
      ).toEqual(['a']);
    });

    // ---- value facets (what fills a console's pickers) ---------------------------------------

    t(
      'enumerates the distinct values of a run column, counted and ordered by frequency',
      async () => {
        if (!store.runValueFacets) return; // optional on the port, like runFacets
        await store.createRun(run({ id: 'a', namespace: 'acme' }));
        await store.createRun(run({ id: 'b', namespace: 'acme' }));
        await store.createRun(run({ id: 'c', namespace: 'globex' }));

        expect(await store.runValueFacets({ field: 'namespace' }, {})).toEqual([
          { value: 'acme', count: 2 },
          { value: 'globex', count: 1 },
        ]);
      },
    );

    t('reports the unattributed bucket as a `null` value, not as a name', async () => {
      if (!store.runValueFacets) return;
      await store.createRun(run({ id: 'a', origin: 'pkg-a' }));
      await store.createRun(run({ id: 'b' }));

      const values = await store.runValueFacets({ field: 'origin' }, {});
      expect(values).toContainEqual({ value: 'pkg-a', count: 1 });
      expect(values).toContainEqual({ value: null, count: 1 });
    });

    t('scopes the values to the SAME predicates the list is under', async () => {
      // The point of a picker: choose a tenant, and the tag picker offers that tenant's tags. A
      // picker that ignored the active filters would offer values whose result set is empty.
      if (!store.runValueFacets) return;
      if (!supportsTagFilter) return;
      await store.createRun(run({ id: 'a', namespace: 'acme', tags: ['etl'] }));
      await store.createRun(run({ id: 'b', namespace: 'globex', tags: ['nightly'] }));

      expect(await store.runValueFacets({ field: 'tag' }, { namespace: 'acme' })).toEqual([
        { value: 'etl', count: 1 },
      ]);
    });

    t('enumerates tags, attribute keys and the values under one key', async () => {
      if (!store.runValueFacets) return;
      await store.createRun(run({ id: 'a', tags: ['etl'], searchAttributes: { tier: 'pro' } }));
      await store.createRun(
        run({ id: 'b', tags: ['etl', 'nightly'], searchAttributes: { tier: 'free' } }),
      );

      expect(await store.runValueFacets({ field: 'tag' }, {})).toEqual([
        { value: 'etl', count: 2 },
        { value: 'nightly', count: 1 },
      ]);
      expect(await store.runValueFacets({ field: 'attributeKey' }, {})).toEqual([
        { value: 'tier', count: 2 },
      ]);
      expect(
        (await store.runValueFacets({ field: 'attributeValue', key: 'tier' }, {}))
          .map((r) => r.value)
          .sort(),
      ).toEqual(['free', 'pro']);
    });

    t('bounds the values it returns, keeping the most common ones', async () => {
      // Tag and attribute cardinality grows with the data (a `singleton:<key>` tag is minted per
      // key), so the unbounded answer is a listing wearing an aggregate's shape.
      if (!store.runValueFacets) return;
      await store.createRun(run({ id: 'a', namespace: 'acme' }));
      await store.createRun(run({ id: 'b', namespace: 'acme' }));
      await store.createRun(run({ id: 'c', namespace: 'globex' }));

      expect(await store.runValueFacets({ field: 'namespace' }, {}, { limit: 1 })).toEqual([
        { value: 'acme', count: 2 },
      ]);
    });

    t('orders listRuns newest-first and paginates with limit/offset', async () => {
      await store.createRun(run({ id: 'old', createdAt: new Date('2026-06-11T00:00:00.000Z') }));
      await store.createRun(run({ id: 'mid', createdAt: new Date('2026-06-11T00:00:01.000Z') }));
      await store.createRun(run({ id: 'new', createdAt: new Date('2026-06-11T00:00:02.000Z') }));

      expect((await store.listRuns({})).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
      expect((await store.listRuns({ limit: 2 })).map((r) => r.id)).toEqual(['new', 'mid']);
      expect((await store.listRuns({ limit: 2, offset: 1 })).map((r) => r.id)).toEqual([
        'mid',
        'old',
      ]);
    });

    // ---- search-attribute pushdown (range + equality + the missing-key contract) ------------

    t('round-trips searchAttributes and answers equality + range attribute queries', async () => {
      await store.createRun(run({ id: 'a', searchAttributes: { amount: 30, tier: 'free' } }));
      await store.createRun(run({ id: 'b', searchAttributes: { amount: 200, tier: 'pro' } }));
      await store.createRun(run({ id: 'c', searchAttributes: { amount: 500, tier: 'pro' } }));

      expect((await store.getRun('b'))?.searchAttributes).toEqual({ amount: 200, tier: 'pro' });

      // Range (numeric).
      expect(
        (await store.listRuns({ attributes: [{ key: 'amount', op: 'gte', value: 200 }] }))
          .map((r) => r.id)
          .sort(),
      ).toEqual(['b', 'c']);
      // Two ANDed predicates (string eq + numeric range).
      expect(
        (
          await store.listRuns({
            attributes: [
              { key: 'tier', op: 'eq', value: 'pro' },
              { key: 'amount', op: 'lt', value: 300 },
            ],
          })
        ).map((r) => r.id),
      ).toEqual(['b']);
      // `ne` excludes the matching value AND absent keys (missing-key-never-matches contract).
      expect(
        (await store.listRuns({ attributes: [{ key: 'tier', op: 'ne', value: 'free' }] }))
          .map((r) => r.id)
          .sort(),
      ).toEqual(['b', 'c']);
    });

    t('matches a boolean search attribute by eq/ne', async () => {
      await store.createRun(run({ id: 'a', searchAttributes: { vip: true } }));
      await store.createRun(run({ id: 'b', searchAttributes: { vip: false } }));
      await store.createRun(run({ id: 'c', searchAttributes: { other: 1 } })); // no `vip`

      expect(
        (await store.listRuns({ attributes: [{ key: 'vip', op: 'eq', value: true }] })).map(
          (r) => r.id,
        ),
      ).toEqual(['a']);
      // ne=true matches the explicit false but NOT the run missing `vip` (missing-key contract).
      expect(
        (await store.listRuns({ attributes: [{ key: 'vip', op: 'ne', value: true }] })).map(
          (r) => r.id,
        ),
      ).toEqual(['b']);
    });

    t('a predicate on an absent key matches nothing (every op)', async () => {
      await store.createRun(run({ id: 'a', searchAttributes: { amount: 100 } }));
      for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const) {
        expect(
          await store.listRuns({ attributes: [{ key: 'missing', op, value: 1 }] }),
        ).toHaveLength(0);
      }
    });

    t(
      're-indexes the search-attribute side-table on update (old values stop matching)',
      async () => {
        await store.createRun(run({ id: 'a', searchAttributes: { tier: 'free', amount: 10 } }));
        expect(
          (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'free' }] })).map(
            (r) => r.id,
          ),
        ).toEqual(['a']);

        await store.updateRun('a', { searchAttributes: { tier: 'pro' } });
        expect(
          (await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'pro' }] })).map(
            (r) => r.id,
          ),
        ).toEqual(['a']);
        // Old key/value pairs are gone.
        expect(
          await store.listRuns({ attributes: [{ key: 'tier', op: 'eq', value: 'free' }] }),
        ).toHaveLength(0);
        expect(
          await store.listRuns({ attributes: [{ key: 'amount', op: 'eq', value: 10 }] }),
        ).toHaveLength(0);
      },
    );

    t('combines an attribute predicate with a coarse status filter and paginates', async () => {
      await store.createRun(run({ id: 'a', status: 'running', searchAttributes: { amount: 300 } }));
      await store.createRun(
        run({ id: 'b', status: 'completed', searchAttributes: { amount: 400 } }),
      );
      await store.createRun(run({ id: 'c', status: 'running', searchAttributes: { amount: 50 } }));

      const res = await store.listRuns({
        status: 'running',
        attributes: [{ key: 'amount', op: 'gte', value: 100 }],
        limit: 10,
      });
      expect(res.map((r) => r.id)).toEqual(['a']);
    });

    // ---- signal waiters & buffered signals --------------------------------------------------

    t('stores, lists by prefix, and atomically takes a signal waiter', async () => {
      await store.putSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
      await store.putSignalWaiter({ token: 'approve-2', runId: 'r2', seq: 4 });
      await store.putSignalWaiter({ token: 'other-1', runId: 'r3', seq: 5 });

      expect((await store.listSignalWaiters('approve-')).map((w) => w.token).sort()).toEqual([
        'approve-1',
        'approve-2',
      ]);
      expect((await store.takeSignalWaiter('approve-1'))?.seq).toBe(3);
      // Taken exactly once.
      expect(await store.takeSignalWaiter('approve-1')).toBeNull();
    });

    t(
      'round-trips a signal waiter parallelGroup (child-fan tag) through put → take → list',
      async () => {
        // A remote `gather_children` fan threads its group onto each child waiter so the resolving
        // `signal:child:` checkpoint carries it; the store must persist it on the waiter row.
        await store.putSignalWaiter({
          token: 'child:r.child.0',
          runId: 'r',
          seq: 0,
          parallelGroup: 'gather:0',
        });
        // A lone (non-fan) child await carries no group.
        await store.putSignalWaiter({ token: 'child:r.child.9', runId: 'r', seq: 9 });

        const listed = await store.listSignalWaiters('child:');
        expect(listed.find((w) => w.token === 'child:r.child.0')?.parallelGroup).toBe('gather:0');
        expect(listed.find((w) => w.token === 'child:r.child.9')?.parallelGroup).toBeUndefined();

        expect((await store.takeSignalWaiter('child:r.child.0'))?.parallelGroup).toBe('gather:0');
        expect((await store.takeSignalWaiter('child:r.child.9'))?.parallelGroup).toBeUndefined();
      },
    );

    t(
      "removeSignalWaiter deletes only the exact (token, runId, seq) row, never a different run's",
      async () => {
        // A stale identity for a token that's since been superseded (`token` is the store's primary
        // key — a later `putSignalWaiter` for the same token replaces the row) must be a no-op: it
        // must NOT steal the new owner's row out from under it.
        await store.putSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
        await store.putSignalWaiter({ token: 'approve-1', runId: 'r2', seq: 7 });
        await store.removeSignalWaiter({ token: 'approve-1', runId: 'r1', seq: 3 });
        expect((await store.listSignalWaiters('approve-')).map((w) => w.runId)).toEqual(['r2']);

        // A mismatched runId/seq against the CURRENT row is also a no-op.
        await store.removeSignalWaiter({ token: 'approve-1', runId: 'r2', seq: 999 });
        expect((await store.listSignalWaiters('approve-')).map((w) => w.runId)).toEqual(['r2']);

        // The exact match deletes it.
        await store.removeSignalWaiter({ token: 'approve-1', runId: 'r2', seq: 7 });
        expect(await store.listSignalWaiters('approve-')).toEqual([]);

        // Removing an absent row entirely is a no-op, not an error.
        await store.removeSignalWaiter({ token: 'never-registered', runId: 'r1', seq: 0 });
      },
    );

    t('buffers signals and takes them FIFO per token', async () => {
      await store.bufferSignal('sig', { n: 1 });
      await store.bufferSignal('sig', { n: 2 });
      await store.bufferSignal('other', { n: 9 });

      expect(await store.takeBufferedSignal('sig')).toEqual({ payload: { n: 1 } });
      expect(await store.takeBufferedSignal('sig')).toEqual({ payload: { n: 2 } });
      expect(await store.takeBufferedSignal('sig')).toBeNull();
      expect(await store.takeBufferedSignal('other')).toEqual({ payload: { n: 9 } });
    });

    t('buffers events per name, oldest-first, and lists them without consuming', async () => {
      await store.bufferEvent({
        name: 'order.paid',
        payload: { n: 1 },
        id: 'e1',
        publishedAt: 100,
      });
      await store.bufferEvent({
        name: 'order.paid',
        payload: { n: 2 },
        id: 'e2',
        publishedAt: 200,
      });
      await store.bufferEvent({
        name: 'other.event',
        payload: { n: 9 },
        id: 'e3',
        publishedAt: 50,
      });

      const listed = await store.listBufferedEvents('order.paid', 10);
      expect(listed.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2 }]); // oldest (publishedAt) first
      expect(listed.map((e) => e.id)).toEqual(['e1', 'e2']);
      expect(listed[0]?.publishedAt).toBe(100);
      // listing does not consume — the same rows are still there.
      expect(await store.listBufferedEvents('order.paid', 10)).toHaveLength(2);
      expect(await store.listBufferedEvents('other.event', 10)).toEqual([
        { id: 'e3', payload: { n: 9 }, publishedAt: 50 },
      ]);
    });

    t('listBufferedEvents caps at `limit`', async () => {
      await store.bufferEvent({ name: 'evt', payload: 1, id: 'a', publishedAt: 1 });
      await store.bufferEvent({ name: 'evt', payload: 2, id: 'b', publishedAt: 2 });
      await store.bufferEvent({ name: 'evt', payload: 3, id: 'c', publishedAt: 3 });

      expect(await store.listBufferedEvents('evt', 2)).toHaveLength(2);
    });

    t(
      'removeBufferedEvent atomically deletes by id — true iff a row existed, false on a repeat/absent id',
      async () => {
        await store.bufferEvent({ name: 'evt', payload: { ok: true }, id: 'x1', publishedAt: 1 });

        expect(await store.removeBufferedEvent('x1')).toBe(true);
        expect(await store.listBufferedEvents('evt', 10)).toEqual([]);
        // Already gone — a second attempt (the concurrent-claim arbiter) reports false, not an error.
        expect(await store.removeBufferedEvent('x1')).toBe(false);
        expect(await store.removeBufferedEvent('never-buffered')).toBe(false);
      },
    );

    // ---- transaction (optional) -------------------------------------------------------------

    t('transaction commits the checkpoint atomically and returns the work result', async () => {
      if (!store.transaction) return; // store without transactions (rare); skip
      if (!supportsAsyncTransaction) return; // sync driver (Drizzle + better-sqlite3); skip — see flag doc
      await store.createRun(run());
      const result = await store.transaction(async (tx) => {
        await tx.saveCheckpoint(checkpoint({ seq: 7, name: 'tx-step', output: { paid: true } }));
        return 'ok';
      });
      expect(result).toBe('ok');
      const cp = await store.getCheckpoint('r1', 7);
      expect(cp?.name).toBe('tx-step');
      expect(cp?.output).toEqual({ paid: true });
    });

    // ---- engine end-to-end durability -------------------------------------------------------

    t(
      'runs the engine end-to-end durably, resuming without re-running completed steps',
      async () => {
        const engine = new WorkflowEngine({ store });
        let aRuns = 0;
        let failOnce = true;
        engine.register('wf', '1', async (ctx) => {
          const a = await ctx.localStep('a', async () => {
            aRuns += 1;
            return 10;
          });
          const b = await ctx.localStep('b', async () => {
            if (failOnce) {
              failOnce = false;
              throw new Error('boom');
            }
            return a + 5;
          });
          return b;
        });
        await engine.start('wf', { x: 1 }, 'run1');
        expect((await engine.waitForRun('run1')).status).toBe('failed');
        const resumed = await engine.resume('run1');
        expect(resumed.status).toBe('completed');
        expect(resumed.output).toBe(15);
        // Step `a` checkpointed `completed` the first turn, so replay returns it instead of re-running.
        expect(aRuns).toBe(1);
      },
    );

    t('starts the version the caller pinned, and refuses one that is not registered', async () => {
      const engine = new WorkflowEngine({ store });
      const ran: string[] = [];
      engine.register('vwf', '1', async () => {
        ran.push('v1');
        return 'v1-output';
      });
      engine.register('vwf', '2', async () => {
        ran.push('v2');
        return 'v2-output';
      });

      await engine.start('vwf', {}, 'pinned-run', { version: '1' });
      const pinned = await engine.waitForRun('pinned-run', { timeoutMs: 20_000 });

      // The OLDER body ran and the store recorded the older version — so this run's every future
      // resume replays v1 too. Asserted against a real store because the version is what the row
      // must carry, not just what the in-process registry believed at start.
      expect(pinned.output).toBe('v1-output');
      expect(ran).toEqual(['v1']);
      expect((await store.getRun('pinned-run'))?.workflowVersion).toBe('1');

      // Unpinned is unchanged: newest wins.
      await engine.start('vwf', {}, 'newest-run');
      expect((await engine.waitForRun('newest-run', { timeoutMs: 20_000 })).output).toBe(
        'v2-output',
      );

      // An unregistered version fails BEFORE a row exists — never a silent fall back to v2.
      await expect(engine.start('vwf', {}, 'ghost-run', { version: '9' })).rejects.toThrow(
        /vwf@9 is not registered/,
      );
      expect(await store.getRun('ghost-run')).toBeNull();
    });

    t('cancels a timed-out run’s live child subtree, not just the run itself', async () => {
      const engine = new WorkflowEngine({ store });
      // Only the parent is timed: a child reaching a terminal state can only be the cascade.
      engine.register('t-grandchild', '1', async (ctx) => ctx.waitForSignal('never'));
      engine.register('t-child', '1', async (ctx) => {
        await ctx.startChild('t-grandchild', {}, 'tgc');
        return ctx.waitForSignal('never');
      });
      engine.register(
        't-parent',
        '1',
        async (ctx) => {
          await ctx.startChild('t-child', {}, 'tc');
          return ctx.waitForSignal('never');
        },
        { executionTimeout: '1h' },
      );

      await engine.start('t-parent', {}, 'tp');
      for (const id of ['tp', 'tc', 'tgc']) {
        expect((await engine.waitForRun(id, { timeoutMs: 20_000 })).status).toBe('suspended');
      }

      await engine.sweepTimeouts(Date.now() + 3_700_000);

      const parent = await store.getRun('tp');
      expect(parent?.status).toBe('cancelled');
      expect(parent?.error?.code).toBe('execution_timeout');
      // Both levels — the cascade is the same recursive walk an explicit `cancel` uses.
      expect((await store.getRun('tc'))?.status).toBe('cancelled');
      expect((await store.getRun('tgc'))?.status).toBe('cancelled');
    });
  });
}
