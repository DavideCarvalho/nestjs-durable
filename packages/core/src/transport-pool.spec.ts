import { describe, expect, it } from 'vitest';
import type { Heartbeat, RemoteTask, StepResult, Transport } from './interfaces';
import { TransportPool } from './transport-pool';

const task = (seq: number): Omit<RemoteTask, 'transport'> => ({
  runId: 'r',
  seq,
  stepId: `r:${seq}`,
  name: 'step',
  group: 'step',
  input: { seq },
  attempt: 1,
});

class Recording implements Transport {
  readonly one: RemoteTask[] = [];
  readonly many: RemoteTask[][] = [];
  failMany = false;
  failOne = false;
  async dispatch(t: RemoteTask): Promise<void> {
    if (this.failOne) throw new Error('down');
    this.one.push(t);
  }
  async dispatchMany(tasks: RemoteTask[]): Promise<void> {
    if (this.failMany) throw new Error('batch refused');
    this.many.push(tasks);
  }
  onResult(_h: (r: StepResult) => Promise<void>): void {}
  onHeartbeat(_h: (b: Heartbeat) => Promise<void>): void {}
}

describe('TransportPool.dispatchMany', () => {
  it('sends the batch in one call to the preferred transport, stamped with its id', async () => {
    const a = new Recording();
    const b = new Recording();
    const pool = new TransportPool([
      { id: 'a', transport: a },
      { id: 'b', transport: b },
    ]);
    await pool.dispatchMany([task(0), task(1)], 'b');
    expect(b.many).toHaveLength(1);
    expect(b.many[0]?.map((t) => [t.seq, t.transport])).toEqual([
      [0, 'b'],
      [1, 'b'],
    ]);
    expect(a.many).toHaveLength(0);
    expect(b.one).toHaveLength(0);
  });

  it('a refused batch is dispatched one task at a time, failing over per task', async () => {
    const a = new Recording();
    const b = new Recording();
    a.failMany = true;
    a.failOne = true;
    const pool = new TransportPool([
      { id: 'a', transport: a },
      { id: 'b', transport: b },
    ]);
    await pool.dispatchMany([task(0), task(1), task(2)]);
    expect(b.one.map((t) => [t.seq, t.transport])).toEqual([
      [0, 'b'],
      [1, 'b'],
      [2, 'b'],
    ]);
  });

  it('a transport without a bulk form gets one dispatch per task', async () => {
    const a = new Recording();
    Object.defineProperty(a, 'dispatchMany', { value: undefined });
    const pool = new TransportPool([{ id: 'a', transport: a }]);
    await pool.dispatchMany(Array.from({ length: 450 }, (_, i) => task(i)));
    expect(a.one).toHaveLength(450);
  });
});
