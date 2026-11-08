import { stepCheckpoint } from './checkpoints';
import { type Completion, childCompletion, completionError, unwrapCompletion } from './completion';
import { NonDeterminismError } from './errors';
import type {
  HistoryEvent,
  SignalWaiter,
  StateStore,
  StepCheckpoint,
  WaitAnyCondition,
  WaitAnyOutcome,
} from './interfaces';

/**
 * `ctx.waitForAny(name, conditions)`: one durable wait over several conditions (signals, timers,
 * child runs), resolved by the FIRST of them, journaled at one position. The machinery lives here so
 * the in-process ctx (`workflow-ctx.ts`) and the remote `waitAny` command (`engine.applyCommands`)
 * resolve it the same way, and the engine's signal delivery ({@link isAnyMember}) can settle it from
 * the sending side.
 *
 * How it stays exactly-once, and why a losing signal is not consumed:
 *
 * - The wait's position holds ONE checkpoint, `any:<name>`, written `pending` the first time the wait
 *   is reached, with the conditions (timers resolved to absolute deadlines) as its `input`. Whoever
 *   flips it to `completed` — through the store's compare-and-set {@link StateStore.saveCheckpointIfPending}
 *   — is the winner. Nothing else arbitrates, so two conditions landing at once can't both win.
 * - Every signal/child condition registers an ordinary waiter on its own token, at the wait's
 *   position, tagged {@link ANY_WAIT_GROUP}. A signal sent while the run waits takes that waiter, as
 *   any signal does, and then tries the compare-and-set. If it loses (another condition already
 *   won, or a timer's deadline passed first) the engine sends the payload again on its token
 *   ({@link WorkflowEngine.signal}), so it is buffered for the next wait on that token instead of
 *   being consumed.
 * - A signal buffered before the wait, or between registering and suspending, is taken here
 *   ({@link takeOldestBuffered}); if that take then loses the compare-and-set, it goes back into the
 *   buffer.
 * - The winner removes the other conditions' waiters. A losing timer is simply never fired (the run's
 *   wake time moves on with its next wait). A losing child keeps running: its completion is buffered
 *   as for any child nobody waits on, so a later `ctx.child(..., id)` still joins it.
 */

/** The `parallelGroup` that marks a signal waiter as one condition of a `waitForAny`. */
export const ANY_WAIT_GROUP = '$any';

/** Name prefix of a `waitForAny` checkpoint (`any:<name>`). */
export const ANY_CHECKPOINT_PREFIX = 'any:';

/** The checkpoint name of the wait called `name`. */
export function anyCheckpointName(name: string): string {
  return `${ANY_CHECKPOINT_PREFIX}${name}`;
}

/** Whether `cp` is a `waitForAny` checkpoint. */
export function isAnyCheckpoint(cp: StepCheckpoint): boolean {
  return cp.kind === 'signal' && cp.name.startsWith(ANY_CHECKPOINT_PREFIX);
}

/** Whether `waiter` is one condition of a `waitForAny`. */
export function isAnyMember(waiter: SignalWaiter): boolean {
  return waiter.parallelGroup === ANY_WAIT_GROUP;
}

/**
 * A condition as the checkpoint stores it: a timer's deadline is absolute (`at`, epoch ms), fixed the
 * first time the wait is reached.
 */
export type StoredAnyCondition =
  | { key: string; kind: 'signal'; signal: string }
  | { key: string; kind: 'timer'; at: number }
  | { key: string; kind: 'child'; childId: string };

/** What the `any:` checkpoint's `input` holds. */
interface AnyCheckpointInput {
  conditions: StoredAnyCondition[];
}

/** The token a signal or child condition waits on; `undefined` for a timer. */
export function anyConditionToken(c: StoredAnyCondition | WaitAnyCondition): string | undefined {
  if (c.kind === 'signal') return c.signal;
  if (c.kind === 'child') return `child:${c.childId}`;
  return undefined;
}

/** The conditions stored on an `any:` checkpoint. */
export function anyConditionsOf(cp: StepCheckpoint): StoredAnyCondition[] {
  return ((cp.input as AnyCheckpointInput | undefined)?.conditions ?? []) as StoredAnyCondition[];
}

/** The earliest deadline among `conditions`, or `undefined` without a timer. */
function earliestDeadline(conditions: StoredAnyCondition[]): number | undefined {
  let at: number | undefined;
  for (const c of conditions) if (c.kind === 'timer' && (at === undefined || c.at < at)) at = c.at;
  return at;
}

/** The timer that is due at `now`: the earliest deadline, the first declared on a tie. */
export function dueTimer(
  conditions: StoredAnyCondition[],
  now: number,
): StoredAnyCondition | undefined {
  let due: StoredAnyCondition | undefined;
  for (const c of conditions) {
    if (c.kind !== 'timer' || c.at > now) continue;
    if (!due || c.at < (due as { at: number }).at) due = c;
  }
  return due;
}

/**
 * What the `any:` checkpoint's `output` holds once settled. `childId` is set when a child condition
 * won: its `value` is then the child's raw `Completion`. Kept in the output (not looked up in the
 * conditions) because a replay snapshot may leave a checkpoint's `input` out.
 */
interface StoredAnyOutcome {
  key: string;
  value: unknown;
  childId?: string;
}

/**
 * The outcome a workflow sees: `{ key, value }`. A child's raw `Completion` is unwrapped here, so a
 * failed child throws like `ctx.child` does.
 */
export function anyOutcomeOf(cp: StepCheckpoint): WaitAnyOutcome {
  const { key, value, childId } = cp.output as StoredAnyOutcome;
  if (childId !== undefined) return { key, value: unwrapCompletion(value, `child "${childId}"`) };
  return { key, value };
}

/** What {@link enterWaitAny} found. */
export type WaitAnyState =
  | { state: 'resolved'; checkpoint: StepCheckpoint }
  | { state: 'waiting'; wakeAt: number | undefined };

/** The store and clock {@link enterWaitAny} works against. */
export interface WaitAnyIo {
  store: StateStore;
  clock(): number;
}

/** A ready condition, and the buffered signal it consumed if that is what made it ready. */
interface Ready {
  condition: StoredAnyCondition;
  value: unknown;
  taken?: { token: string; payload: unknown };
}

/**
 * Take the oldest buffered signal among `tokens`: through the store's
 * {@link StateStore.takeOldestBufferedSignal} when it has one (the earliest signal wins, whichever
 * condition it matches), otherwise token by token in declaration order.
 */
export async function takeOldestBuffered(
  store: StateStore,
  tokens: string[],
): Promise<{ token: string; payload: unknown } | null> {
  if (tokens.length === 0) return null;
  if (store.takeOldestBufferedSignal) return store.takeOldestBufferedSignal(tokens);
  for (const token of tokens) {
    const taken = await store.takeBufferedSignal(token);
    if (taken) return { token, payload: taken.payload };
  }
  return null;
}

/** Write `cp` only while the stored row is still `pending`; resolves whether it wrote. */
export async function claimAnyCheckpoint(store: StateStore, cp: StepCheckpoint): Promise<boolean> {
  if (store.saveCheckpointIfPending) return store.saveCheckpointIfPending(cp);
  // Without a compare-and-set the read and the write are two statements: two conditions landing in
  // between can both write. Every bundled store implements it.
  const current = await store.getCheckpoint(cp.runId, cp.seq);
  if (current?.status !== 'pending') return false;
  await store.saveCheckpoint(cp);
  return true;
}

/** `pending` checkpoint `cp` resolved with `outcome`. */
export function resolvedAnyCheckpoint(
  cp: StepCheckpoint,
  condition: StoredAnyCondition,
  value: unknown,
): StepCheckpoint {
  const output: StoredAnyOutcome =
    condition.kind === 'child'
      ? { key: condition.key, value, childId: condition.childId }
      : { key: condition.key, value };
  return {
    ...cp,
    status: 'completed',
    output,
    wakeAt: undefined,
    finishedAt: new Date(),
  };
}

/** Remove every condition waiter of the wait at `cp`. Exact rows only, never another run's. */
export async function removeAnyWaiters(store: StateStore, cp: StepCheckpoint): Promise<void> {
  await Promise.all(
    anyConditionsOf(cp).flatMap((c) => {
      const token = anyConditionToken(c);
      return token === undefined
        ? []
        : [
            store.removeSignalWaiter({
              token,
              runId: cp.runId,
              seq: cp.seq,
              parallelGroup: ANY_WAIT_GROUP,
            }),
          ];
    }),
  );
}

/**
 * Resolve a waiting `waitForAny` with `ready`, if it is still waiting. On a lost race, a signal this
 * call took from the buffer is put back, and the winner's checkpoint is returned.
 */
async function settle(
  store: StateStore,
  cp: StepCheckpoint,
  ready: Ready,
): Promise<StepCheckpoint | undefined> {
  const done = resolvedAnyCheckpoint(cp, ready.condition, ready.value);
  if (await claimAnyCheckpoint(store, done)) {
    await removeAnyWaiters(store, done);
    return done;
  }
  if (ready.taken) await store.bufferSignal(ready.taken.token, ready.taken.payload);
  const winner = await store.getCheckpoint(cp.runId, cp.seq);
  return winner?.status === 'completed' ? winner : undefined;
}

/**
 * The condition ready now, in this order: the oldest buffered signal (or child completion), a child
 * that already finished, then the earliest due timer.
 */
async function readyCondition(
  io: WaitAnyIo,
  conditions: StoredAnyCondition[],
): Promise<Ready | undefined> {
  const tokens: string[] = [];
  for (const c of conditions) {
    const token = anyConditionToken(c);
    if (token !== undefined && !tokens.includes(token)) tokens.push(token);
  }
  const taken = await takeOldestBuffered(io.store, tokens);
  if (taken) {
    const condition = conditions.find((c) => anyConditionToken(c) === taken.token);
    if (condition) return { condition, value: taken.payload, taken };
  }
  for (const c of conditions) {
    if (c.kind !== 'child') continue;
    const child = await io.store.getRun(c.childId);
    const completion = child ? childCompletion(child) : undefined;
    if (completion) return { condition: c, value: completion };
  }
  const due = dueTimer(conditions, io.clock());
  return due ? { condition: due, value: null } : undefined;
}

/**
 * Reach the `waitForAny` called `name` at position `seq` of run `runId`: resolve it if a condition is
 * ready, otherwise make sure every condition is registered and say when to wake. Idempotent, so a
 * replay, a re-sent remote command or a recovery can call it again.
 */
export async function enterWaitAny(
  io: WaitAnyIo,
  runId: string,
  seq: number,
  name: string,
  conditions: WaitAnyCondition[],
): Promise<WaitAnyState> {
  const { store } = io;
  const cpName = anyCheckpointName(name);
  let cp = await store.getCheckpoint(runId, seq);
  if (cp && cp.name !== cpName) throw new NonDeterminismError(runId, seq, cpName, cp.name);
  if (cp?.status === 'completed') return { state: 'resolved', checkpoint: cp };
  if (!cp) {
    const now = io.clock();
    const stored = conditions.map(
      (c): StoredAnyCondition =>
        c.kind === 'timer'
          ? { key: c.key, kind: 'timer', at: c.until ?? now + (c.ms ?? 0) }
          : c.kind === 'signal'
            ? { key: c.key, kind: 'signal', signal: c.signal }
            : { key: c.key, kind: 'child', childId: c.childId },
    );
    const at = new Date(now);
    cp = stepCheckpoint({
      runId,
      seq,
      name: cpName,
      kind: 'signal',
      status: 'pending',
      attempts: 1,
      input: { conditions: stored } satisfies AnyCheckpointInput,
      wakeAt: earliestDeadline(stored),
      enqueuedAt: at,
      startedAt: at,
      finishedAt: at,
    });
    await store.saveCheckpoint(cp);
  }
  const stored = anyConditionsOf(cp);
  const ready = await readyCondition(io, stored);
  if (ready) {
    const winner = await settle(store, cp, ready);
    if (winner) return { state: 'resolved', checkpoint: winner };
  }
  // Register every condition, then look once more before suspending: a signal sent between the look
  // above and its waiter's registration found no waiter and was buffered (the same check → register
  // → re-check as `waitForSignal`, paired with `engine.signal`'s take → buffer → re-take).
  for (const c of stored) {
    const token = anyConditionToken(c);
    if (token === undefined) continue;
    await store.putSignalWaiter({ token, runId, seq, parallelGroup: ANY_WAIT_GROUP });
  }
  const late = await readyCondition(io, stored);
  if (late) {
    const winner = await settle(store, cp, late);
    if (winner) return { state: 'resolved', checkpoint: winner };
  }
  return { state: 'waiting', wakeAt: earliestDeadline(stored) };
}

/**
 * A settled `waitForAny` checkpoint as a remote worker's replay sees it: an `any` history event named
 * after the wait, whose output is `{ key, value }`. A winning child's output is unwrapped; a child
 * that failed is the event's `error`, with `{ key }` as its output.
 */
export function anyHistoryEvent(cp: StepCheckpoint): HistoryEvent {
  const { key, value, childId } = cp.output as StoredAnyOutcome;
  const name = cp.name.slice(ANY_CHECKPOINT_PREFIX.length);
  if (childId !== undefined) {
    const completion = value as Completion<unknown> | undefined;
    if (completion && completion.ok === false) {
      return {
        seq: cp.seq,
        kind: 'any',
        name,
        output: { key },
        error: completionError(completion),
      };
    }
    return {
      seq: cp.seq,
      kind: 'any',
      name,
      output: { key, value: completion?.ok ? completion.value : undefined },
    };
  }
  return { seq: cp.seq, kind: 'any', name, output: { key, value } };
}
