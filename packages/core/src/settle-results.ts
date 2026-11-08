import type {
  StateStore,
  StepCheckpoint,
  StepResultSettlement,
  StepSettlement,
} from './interfaces';

/**
 * {@link StateStore.settleResultsIfPending} built on a store's batched plain calls, for an adapter on
 * a database without `RETURNING` (MySQL) settling a batch of results: the batch's runs and rows are
 * read once each, the rows still `pending` of runs not finished are settled with
 * {@link StateStore.settleCheckpointsIfPending} (one batched, transactional call), and the rows it
 * settled are read back. A fixed number of statements however wide the batch, where settling each
 * result on its own would cost two per result.
 */
export async function settleResultsWithPlainCalls(
  store: Pick<StateStore, 'getRun' | 'getCheckpoint'> &
    Partial<
      Pick<
        StateStore,
        'getRuns' | 'getCheckpointsForSettle' | 'getCheckpoints' | 'settleCheckpointsIfPending'
      >
    >,
  results: StepResultSettlement[],
): Promise<(StepCheckpoint | null)[]> {
  const out: (StepCheckpoint | null)[] = results.map(() => null);
  const key = (runId: string, seq: number) => `${seq}:${runId}`;
  const seqsByRun = new Map<string, number[]>();
  for (const r of results) seqsByRun.set(r.runId, [...(seqsByRun.get(r.runId) ?? []), r.seq]);
  const runIds = [...seqsByRun.keys()];
  const runs = store.getRuns
    ? await store.getRuns(runIds)
    : (await Promise.all(runIds.map((id) => store.getRun(id)))).filter((r) => r !== null);
  const finished = new Set(
    runs.filter((r) => r.status === 'cancelled' || r.status === 'completed').map((r) => r.id),
  );
  const read = async (runId: string, seqs: number[]): Promise<StepCheckpoint[]> => {
    if (store.getCheckpointsForSettle) return store.getCheckpointsForSettle(runId, seqs);
    if (store.getCheckpoints) return store.getCheckpoints(runId, seqs);
    const rows = await Promise.all(seqs.map((seq) => store.getCheckpoint(runId, seq)));
    return rows.filter((cp) => cp !== null);
  };
  const before = new Map<string, StepCheckpoint>();
  for (const [runId, seqs] of seqsByRun) {
    if (finished.has(runId)) continue;
    for (const cp of await read(runId, seqs)) before.set(key(runId, cp.seq), cp);
  }
  const claimed = new Set<string>();
  const settlements: StepSettlement[] = [];
  const at: number[] = [];
  for (const [i, r] of results.entries()) {
    const k = key(r.runId, r.seq);
    const cp = before.get(k);
    if (cp?.status !== 'pending' || claimed.has(k)) continue;
    claimed.add(k);
    settlements.push({
      runId: r.runId,
      seq: r.seq,
      status: r.status,
      output: r.status === 'completed' ? r.output : cp.output,
      error: r.error,
      events: r.events ?? cp.events,
      startedAt: r.startedAt ?? cp.startedAt,
      finishedAt: r.finishedAt,
    });
    at.push(i);
  }
  if (settlements.length === 0 || !store.settleCheckpointsIfPending) return out;
  const wrote = await store.settleCheckpointsIfPending(settlements);
  const won = settlements.filter((_, j) => wrote[j] === true);
  const after = new Map<string, StepCheckpoint>();
  const wonByRun = new Map<string, number[]>();
  for (const s of won) wonByRun.set(s.runId, [...(wonByRun.get(s.runId) ?? []), s.seq]);
  for (const [runId, seqs] of wonByRun) {
    for (const cp of await read(runId, seqs)) after.set(key(runId, cp.seq), cp);
  }
  settlements.forEach((s, j) => {
    if (wrote[j] === true) out[at[j] as number] = after.get(key(s.runId, s.seq)) ?? null;
  });
  return out;
}
