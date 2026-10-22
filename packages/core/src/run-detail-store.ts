import { CHILD_EDGE_PREFIXES, childIdsOf } from './engine';
import { FOLDED_PREFIX, parseFanGroup } from './fan-join';
import {
  type CheckpointQuery,
  type CheckpointStat,
  type StateStore,
  type StepCheckpoint,
  type WorkflowRun,
  checkpointNameKind,
} from './interfaces';
import {
  FAN_SUMMARY_FAILURES,
  type FanPage,
  type FanPageQuery,
  type FanSummary,
  SUMMARY_CHILD_LIMIT,
  fanPageBounds,
  foldedCount,
  isFailedMember,
} from './run-detail-summary';

/** A store that aggregates checkpoints itself: both halves of the pair are present. */
export type CheckpointAggregatingStore = StateStore &
  Required<Pick<StateStore, 'checkpointStats' | 'queryCheckpoints'>>;

export function aggregatesCheckpoints(store: StateStore): store is CheckpointAggregatingStore {
  return store.checkpointStats !== undefined && store.queryCheckpoints !== undefined;
}

/**
 * {@link StateStore.checkpointStats} over checkpoints already in memory — the reference a store's
 * `GROUP BY` must agree with, and the in-memory store's implementation.
 */
export function checkpointStatsOf(
  checkpoints: StepCheckpoint[],
  opts?: { group?: string | undefined },
): CheckpointStat[] {
  const buckets = new Map<string, CheckpointStat>();
  for (const cp of checkpoints) {
    const group = cp.parallelGroup ?? null;
    if (opts?.group !== undefined && group !== opts.group) continue;
    const nameKind = checkpointNameKind(cp.name);
    const key = JSON.stringify([group, cp.status, nameKind]);
    const enqueuedAt = cp.enqueuedAt ?? cp.startedAt;
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, {
        group,
        status: cp.status,
        nameKind,
        count: 1,
        minSeq: cp.seq,
        maxSeq: cp.seq,
        minName: cp.name,
        maxName: cp.name,
        minEnqueuedAt: enqueuedAt,
        minStartedAt: cp.startedAt,
        maxStartedAt: cp.startedAt,
        maxFinishedAt: cp.finishedAt,
        sumAttempts: cp.attempts,
      });
      continue;
    }
    bucket.count += 1;
    bucket.minSeq = Math.min(bucket.minSeq, cp.seq);
    bucket.maxSeq = Math.max(bucket.maxSeq, cp.seq);
    if (cp.name < bucket.minName) bucket.minName = cp.name;
    if (cp.name > bucket.maxName) bucket.maxName = cp.name;
    if (enqueuedAt < bucket.minEnqueuedAt) bucket.minEnqueuedAt = enqueuedAt;
    if (cp.startedAt < bucket.minStartedAt) bucket.minStartedAt = cp.startedAt;
    if (cp.startedAt > bucket.maxStartedAt) bucket.maxStartedAt = cp.startedAt;
    if (cp.finishedAt > bucket.maxFinishedAt) bucket.maxFinishedAt = cp.finishedAt;
    bucket.sumAttempts += cp.attempts;
  }
  return [...buckets.values()];
}

/** {@link StateStore.queryCheckpoints} over checkpoints already in memory, sorted by `seq` here. */
export function queryCheckpointsOf(
  checkpoints: StepCheckpoint[],
  query: CheckpointQuery,
): StepCheckpoint[] {
  const excluded = new Set(query.excludeGroups ?? []);
  const matching = checkpoints
    .filter(
      (cp) =>
        (query.group === undefined || cp.parallelGroup === query.group) &&
        (cp.parallelGroup === undefined || !excluded.has(cp.parallelGroup)) &&
        (query.statuses === undefined || query.statuses.includes(cp.status)) &&
        (query.namePrefixes === undefined ||
          query.namePrefixes.some((prefix) => cp.name.startsWith(prefix))),
    )
    .sort((a, b) => a.seq - b.seq);
  const offset = query.offset ?? 0;
  return matching.slice(offset, query.limit === undefined ? undefined : offset + query.limit);
}

const TERMINAL = (status: StepCheckpoint['status']) => status !== 'pending' && status !== 'running';

/** True when a group with `rows` checkpoints is summarized: the rule of `summarizeTimeline`. */
function isWide(group: string, rows: number, over: number): boolean {
  return rows > over || (parseFanGroup(group)?.size ?? 0) > over;
}

/** Merge two seq-sorted lists of distinct checkpoints into one, in seq order. */
function mergeBySeq(a: StepCheckpoint[], b: StepCheckpoint[]): StepCheckpoint[] {
  return [...a, ...b].sort((x, y) => x.seq - y.seq);
}

/**
 * A child of a fan whose `signal:child:` checkpoint is `completed` failed when its completion says
 * `ok: false` — a payload the store cannot read (a codec may encode it), so those rows are loaded
 * and judged here. Only the completed child rows of the one group are read.
 */
async function failedChildren(
  store: CheckpointAggregatingStore,
  runId: string,
  group: string,
  buckets: CheckpointStat[],
): Promise<{ completed: StepCheckpoint[]; failed: StepCheckpoint[] }> {
  if (!buckets.some((b) => b.nameKind === 'child' && b.status === 'completed')) {
    return { completed: [], failed: [] };
  }
  const completed = await store.queryCheckpoints(runId, {
    group,
    statuses: ['completed'],
    namePrefixes: ['signal:child:'],
  });
  return { completed, failed: completed.filter(isFailedMember) };
}

async function summarizeFanFromStats(
  store: CheckpointAggregatingStore,
  runId: string,
  group: string,
  buckets: CheckpointStat[],
  folded: StepCheckpoint[],
): Promise<FanSummary> {
  const counts: FanSummary['counts'] = {};
  const add = (status: StepCheckpoint['status'], n: number) => {
    counts[status] = (counts[status] ?? 0) + n;
  };
  let size = 0;
  let startedAt: Date | undefined;
  let finishedAt: Date | undefined;
  let firstSeq = Number.POSITIVE_INFINITY;
  let lastSeq = Number.NEGATIVE_INFINITY;
  let minName: string | undefined;
  let maxName: string | undefined;
  let childRuns = false;
  for (const b of buckets) {
    firstSeq = Math.min(firstSeq, b.minSeq);
    lastSeq = Math.max(lastSeq, b.maxSeq);
    if (minName === undefined || b.minName < minName) minName = b.minName;
    if (maxName === undefined || b.maxName > maxName) maxName = b.maxName;
    if (b.nameKind === 'child' || b.nameKind === 'folded') childRuns = true;
    if (TERMINAL(b.status)) {
      if (!startedAt || b.minStartedAt < startedAt) startedAt = b.minStartedAt;
      if (!finishedAt || b.maxFinishedAt > finishedAt) finishedAt = b.maxFinishedAt;
    } else if (!startedAt || b.minEnqueuedAt < startedAt) {
      startedAt = b.minEnqueuedAt;
    }
    // Folded rows and completed child rows count by their payload, below.
    if (b.nameKind === 'folded') continue;
    if (b.nameKind === 'child' && b.status === 'completed') continue;
    add(b.status, b.count);
    size += b.count;
  }
  for (const cp of folded) {
    const n = foldedCount(cp) ?? 1;
    add(isFailedMember(cp) ? 'failed' : cp.status, n);
    size += n;
  }
  const children = await failedChildren(store, runId, group, buckets);
  const failedChildSet = new Set(children.failed);
  for (const cp of children.completed) add(failedChildSet.has(cp) ? 'failed' : 'completed', 1);
  size += children.completed.length;

  const failedStatusRows = buckets.some((b) => b.status === 'failed')
    ? await store.queryCheckpoints(runId, {
        group,
        statuses: ['failed'],
        limit: FAN_SUMMARY_FAILURES,
      })
    : [];
  const failures = mergeBySeq(failedStatusRows, children.failed).slice(0, FAN_SUMMARY_FAILURES);

  const parsed = parseFanGroup(group);
  const total = parsed?.size;
  return {
    group,
    label: childRuns ? 'child runs' : minName === maxName ? (minName ?? '') : 'steps',
    firstSeq,
    lastSeq,
    size,
    total,
    notStarted: total === undefined ? undefined : Math.max(0, total - size),
    failFast: parsed?.failFast ?? false,
    counts,
    startedAt,
    finishedAt,
    failures,
  };
}

/** The first {@link SUMMARY_CHILD_LIMIT} child ids, in the order `childIdsOf` lists them. */
async function firstChildIds(store: CheckpointAggregatingStore, runId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ids.length < SUMMARY_CHILD_LIMIT; offset += SUMMARY_CHILD_LIMIT) {
    const page = await store.queryCheckpoints(runId, {
      namePrefixes: CHILD_EDGE_PREFIXES,
      offset,
      limit: SUMMARY_CHILD_LIMIT,
    });
    ids.push(...childIdsOf(page));
    if (page.length < SUMMARY_CHILD_LIMIT) break;
  }
  return ids.slice(0, SUMMARY_CHILD_LIMIT);
}

/**
 * What `summarizeTimeline` plus `childIdsOf` make of a run's whole checkpoint list, read through the
 * store's aggregates instead: the checkpoints outside wide fans, one {@link FanSummary} per wide fan,
 * and the run's children capped at {@link SUMMARY_CHILD_LIMIT} with their count.
 *
 * What it reads besides the aggregates: the rows outside wide fans, every folded `fan:` checkpoint
 * (one per settled wave), up to {@link FAN_SUMMARY_FAILURES} failed rows per wide fan, the first
 * child-edge rows, and — while a wide child fan is in flight — that fan's completed `signal:child:`
 * rows, whose `ok: false` payload is what marks a failed child.
 *
 * `childCount` counts each `spawn:` checkpoint as one child: the engine always writes the child's id
 * as its output, which is what `childIdsOf` reads.
 */
export async function summarizeRunFromStore(
  store: CheckpointAggregatingStore,
  runId: string,
  over: number,
  stats?: CheckpointStat[],
): Promise<{
  timeline: StepCheckpoint[];
  fans: FanSummary[];
  children: string[];
  childCount: number;
}> {
  const all = stats ?? (await store.checkpointStats(runId));
  const byGroup = new Map<string, CheckpointStat[]>();
  let edgeRows = 0;
  let hasFolded = false;
  for (const b of all) {
    if (b.nameKind === 'child' || b.nameKind === 'spawn') edgeRows += b.count;
    if (b.nameKind === 'folded') hasFolded = true;
    if (b.group === null) continue;
    const buckets = byGroup.get(b.group);
    if (buckets) buckets.push(b);
    else byGroup.set(b.group, [b]);
  }
  const wide = [...byGroup].filter(([group, buckets]) =>
    isWide(
      group,
      buckets.reduce((n, b) => n + b.count, 0),
      over,
    ),
  );
  const [timeline, folded, children] = await Promise.all([
    store.queryCheckpoints(runId, { excludeGroups: wide.map(([group]) => group) }),
    hasFolded ? store.queryCheckpoints(runId, { namePrefixes: [FOLDED_PREFIX] }) : [],
    edgeRows > 0 || hasFolded ? firstChildIds(store, runId) : [],
  ]);
  const fans = await Promise.all(
    wide.map(([group, buckets]) =>
      summarizeFanFromStats(
        store,
        runId,
        group,
        buckets,
        folded.filter((cp) => cp.parallelGroup === group),
      ),
    ),
  );
  const childCount = folded.reduce((n, cp) => n + childIdsOf([cp]).length, edgeRows);
  return {
    timeline,
    fans: fans.sort((a, b) => a.firstSeq - b.firstSeq),
    children,
    childCount,
  };
}

/** What `pageFan` makes of a run's whole checkpoint list, read one page at a time from the store. */
export async function pageFanFromStore(
  store: CheckpointAggregatingStore,
  runId: string,
  group: string,
  query: FanPageQuery,
  stats?: CheckpointStat[],
): Promise<FanPage> {
  const buckets = stats ?? (await store.checkpointStats(runId, { group }));
  const { offset, limit } = fanPageBounds(query);
  if (!query.failedOnly) {
    const total = buckets.reduce((n, b) => n + b.count, 0);
    const items =
      total > offset ? await store.queryCheckpoints(runId, { group, offset, limit }) : [];
    return { items, total };
  }
  const failedStatus = buckets
    .filter((b) => b.status === 'failed')
    .reduce((n, b) => n + b.count, 0);
  const children = await failedChildren(store, runId, group, buckets);
  const total = failedStatus + children.failed.length;
  if (total <= offset) return { items: [], total };
  if (children.failed.length === 0) {
    return {
      items: await store.queryCheckpoints(runId, { group, statuses: ['failed'], offset, limit }),
      total,
    };
  }
  // The page's members are among the first `offset + limit` of each kind of failure.
  const failedRows = await store.queryCheckpoints(runId, {
    group,
    statuses: ['failed'],
    limit: offset + limit,
  });
  return {
    items: mergeBySeq(failedRows, children.failed).slice(offset, offset + limit),
    total,
  };
}

/** A 53-bit string hash (cyrb53), as hex: enough to tell two fingerprints apart. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * The checkpoint half of a change marker. There is no per-checkpoint write version to read, so it
 * is the buckets themselves: every engine write to a checkpoint adds a row, moves a row to another
 * status bucket, or rewrites a row's timestamps or attempts — and each of those moves a bucket's
 * count, seq range, timestamp bounds or attempt sum.
 */
function statsFingerprint(stats: CheckpointStat[]): string {
  return stats
    .map((b) =>
      [
        b.group ?? '',
        b.status,
        b.nameKind,
        b.count,
        b.minSeq,
        b.maxSeq,
        b.minName,
        b.maxName,
        b.minEnqueuedAt.getTime(),
        b.minStartedAt.getTime(),
        b.maxStartedAt.getTime(),
        b.maxFinishedAt.getTime(),
        b.sumAttempts,
      ].join('\u0001'),
    )
    .sort()
    .join('\u0002');
}

/**
 * The ETag of a summarized run detail: the run row as read (so any run field that changes shows)
 * plus its checkpoint buckets, and the threshold it was summarized with.
 */
export function runDetailEtag(run: WorkflowRun, stats: CheckpointStat[], over: number): string {
  return `"rd-${hash(`${over}\u0003${JSON.stringify(run)}\u0003${statsFingerprint(stats)}`)}"`;
}

/** The ETag of one page of a fan: its group's buckets and the page asked for. */
export function fanPageEtag(group: string, stats: CheckpointStat[], query: FanPageQuery): string {
  const { offset, limit } = fanPageBounds(query);
  const key = [group, offset, limit, query.failedOnly === true].join('\u0001');
  return `"fp-${hash(`${key}\u0003${statsFingerprint(stats)}`)}"`;
}

/** Whether an `If-None-Match` header value names `etag` (weak comparison, as RFC 9110 asks for). */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  const target = bare(etag);
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || bare(tag) === target);
}
