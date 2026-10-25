import { WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { MikroORM } from '@mikro-orm/mysql';
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  BufferedSignalEntity,
  ENTITIES,
  StepCheckpointEntity,
  WorkflowRunEntity,
} from './entities';
import { MikroOrmStateStore } from './mikro-orm-state-store';

/**
 * Cost harness, not a regression test: the buffered-signal sweep and the child-completion check on
 * MikroORM over a real MySQL, against the table shape that kept a worker's first timer poll from
 * finishing. One old 40k-child `ctx.all` parent (still open, its 40k checkpoints present) with 20k
 * of its children's completions buffered, 22k more buffered completions of other runs, ~380k
 * checkpoints and ~167k runs overall. Prints one `HARNESS {...}` line: one sweep tick (time,
 * statements, rows the server read), the full drain, and the write-path check per completion.
 *
 * Opt-in, and skipped otherwise (it starts nothing):
 *
 *   DURABLE_HARNESS=1 pnpm test:db packages/store-mikro-orm/src/buffered-sweep.harness.db.spec.ts
 *
 * Knobs (environment): `H_FAN` the wide parent's children (40000), `H_ORPHANS` its buffered rows
 * (20000), `H_OTHER_BUFFERED` other buffered rows (22000), `H_RUNS` other runs (167000),
 * `H_CHECKPOINTS` other checkpoints (340000), `H_DRAIN` `0` to skip the full drain.
 * `DURABLE_HARNESS_MYSQL_URL` points it at an existing server instead of a testcontainer.
 */

const enabled = process.env.DURABLE_HARNESS === '1';
const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
};
const fan = num('H_FAN', 40_000);
const orphans = num('H_ORPHANS', 20_000);
const otherBuffered = num('H_OTHER_BUFFERED', 22_000);
const otherRuns = num('H_RUNS', 167_000);
const otherCheckpoints = num('H_CHECKPOINTS', 340_000);
const drain = num('H_DRAIN', 1) === 1;

const PARENT = '01a15edf-0000-4000-8000-000000000000';
const CHUNK = 2_000;

let mysql: StartedMySqlContainer | undefined;
let mysqlUrl = process.env.DURABLE_HARNESS_MYSQL_URL;

beforeAll(async () => {
  if (!enabled || mysqlUrl) return;
  mysql = await new MySqlContainer('mysql:8.0').start();
  mysqlUrl = `mysql://${mysql.getUsername()}:${mysql.getUserPassword()}@${mysql.getHost()}:${mysql.getPort()}/${mysql.getDatabase()}`;
}, 300_000);

afterAll(async () => {
  await mysql?.stop();
});

async function inChunks<T>(
  n: number,
  make: (i: number) => T,
  write: (rows: T[]) => Promise<unknown>,
) {
  for (let from = 0; from < n; from += CHUNK) {
    const rows: T[] = [];
    for (let i = from; i < Math.min(n, from + CHUNK); i++) rows.push(make(i));
    await write(rows);
  }
}

describe.runIf(enabled)('buffered-signal sweep on MikroORM/MySQL (harness)', () => {
  it(`one tick over ${orphans + otherBuffered} buffered rows, ${fan}-child parent`, async () => {
    let statements = 0;
    const orm = await MikroORM.init({
      clientUrl: mysqlUrl,
      entities: [...ENTITIES],
      allowGlobalContext: true,
      debug: ['query'],
      logger: () => {
        statements += 1;
      },
    });
    const store = new MikroOrmStateStore(orm);
    await store.ensureSchema();
    const em = orm.em.fork();
    const at = new Date();
    const run = (id: string, status: string) =>
      Object.assign(new WorkflowRunEntity(), {
        id,
        workflow: 'load',
        workflowVersion: '1',
        status,
        input: {},
        namespace: '',
        createdAt: at,
        updatedAt: at,
      });
    const checkpoint = (runId: string, seq: number, name: string, output: unknown) =>
      Object.assign(new StepCheckpointEntity(), {
        runId,
        seq,
        name,
        kind: 'signal',
        stepId: `${runId}:${seq}`,
        status: 'completed',
        output,
        attempts: 1,
        parallelGroup: 'all:0:n100',
        startedAt: at,
        finishedAt: at,
      });

    const seedStarted = Date.now();
    await em.insertMany(WorkflowRunEntity, [run(PARENT, 'suspended')]);
    await inChunks(
      otherRuns,
      (i) => run(`run-${i}`, i % 3 === 0 ? 'suspended' : 'completed'),
      (rows) => em.insertMany(WorkflowRunEntity, rows),
    );
    await inChunks(
      fan,
      (i) =>
        checkpoint(PARENT, i, `signal:child:${PARENT}.all.0.${i}`, {
          ok: true,
          value: { line: i, rows: [i, i + 1, i + 2], note: 'x'.repeat(64) },
        }),
      (rows) => em.insertMany(StepCheckpointEntity, rows),
    );
    await inChunks(
      otherCheckpoints,
      (i) => checkpoint(`run-${i % otherRuns}`, Math.floor(i / otherRuns), `step-${i}`, { i }),
      (rows) => em.insertMany(StepCheckpointEntity, rows),
    );
    // The wide parent's orphans first (the oldest rows), then completions of other runs: roots,
    // pruned parents, and settled parents.
    await inChunks(
      orphans,
      (i) => {
        const child = fan - orphans + i;
        return Object.assign(new BufferedSignalEntity(), {
          token: `child:${PARENT}.all.0.${child}`,
          payload: {
            ok: true,
            value: { line: child, rows: [child, child + 1, child + 2], note: 'x'.repeat(64) },
          },
        });
      },
      (rows) => em.insertMany(BufferedSignalEntity, rows),
    );
    await inChunks(
      otherBuffered,
      (i) =>
        Object.assign(new BufferedSignalEntity(), {
          token: i % 2 === 0 ? `child:root-${i}` : `child:run-${i % otherRuns}.child.${i}`,
          payload: { ok: true, value: i },
        }),
      (rows) => em.insertMany(BufferedSignalEntity, rows),
    );
    const seedMs = Date.now() - seedStarted;

    const rowsRead = async (): Promise<number> => {
      const rows = (await em
        .getConnection()
        .execute("SHOW GLOBAL STATUS LIKE 'Handler_read%'")) as { Value: string }[];
      return rows.reduce((sum, row) => sum + Number(row.Value), 0);
    };
    const measure = async (work: () => Promise<unknown>) => {
      const s0 = statements;
      const r0 = await rowsRead();
      const t0 = performance.now();
      const result = await work();
      const ms = Math.round(performance.now() - t0);
      return { ms, statements: statements - s0 - 0, rowsRead: (await rowsRead()) - r0, result };
    };

    const engine = new WorkflowEngine({ store });
    const tick = await measure(() => engine.sweepBufferedSignals());

    let fullDrain: { ms: number; ticks: number; deleted: number } | undefined;
    if (drain) {
      const t0 = performance.now();
      let ticks = 1;
      let deleted = tick.result as number;
      const internals = engine as unknown as { bufferedSweepCursor?: string };
      while (internals.bufferedSweepCursor !== undefined && ticks < 10_000) {
        deleted += await engine.sweepBufferedSignals();
        ticks += 1;
      }
      fullDrain = { ms: Math.round(performance.now() - t0) + tick.ms, ticks, deleted };
    }

    // The write path: a duplicate notification for a settled child of the wide parent.
    const deliver = engine as unknown as {
      deliverToParent(token: string, completion: unknown): Promise<void>;
    };
    const calls = 200;
    const write = await measure(async () => {
      for (let k = 0; k < calls; k++) {
        const i = (k * 197) % fan;
        await deliver.deliverToParent(`child:${PARENT}.all.0.${i}`, {
          ok: true,
          value: { line: i, rows: [i, i + 1, i + 2], note: 'x'.repeat(64) },
        });
      }
    });

    console.log(
      `HARNESS ${JSON.stringify({
        seedMs,
        oneTick: {
          ms: tick.ms,
          statements: tick.statements,
          rowsRead: tick.rowsRead,
          deleted: tick.result,
        },
        fullDrain,
        writePathPerCompletion: {
          ms: +(write.ms / calls).toFixed(2),
          statements: +(write.statements / calls).toFixed(2),
          rowsRead: Math.round(write.rowsRead / calls),
        },
      })}`,
    );
    await orm.close(true);
  }, 3_600_000);
});
