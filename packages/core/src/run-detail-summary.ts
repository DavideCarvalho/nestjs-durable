import { FOLDED_PREFIX, type FoldedChildren, parseFanGroup } from './fan-join';
import type { StepCheckpoint } from './interfaces';

/**
 * A parallel fan (a `ctx.all`, a step fan, a polyglot `gather`) reduced to what a detail view needs
 * to draw it: one node, its progress and its failures. A run detail with a 40,000-item fan otherwise
 * carries every member — megabytes of JSON, and one rendered row (or fetched child) per member.
 */
export interface FanSummary {
  /** The fan's `parallelGroup`. */
  group: string;
  /** The members' common step name, or `child runs` for a fan of child workflows. */
  label: string;
  firstSeq: number;
  lastSeq: number;
  /** Members started so far: steps, or child runs (a folded checkpoint counts as the children it stands for). */
  size: number;
  /**
   * The fan's declared size, when its group carries it. More than `size` while waves are still to
   * be sent (`concurrency`), and for good when a failFast fan stopped early.
   */
  total?: number | undefined;
  /** `total - size`: members never started yet — or never to start, once the run has finished. */
  notStarted?: number | undefined;
  /** The fan stops at its first failure. */
  failFast: boolean;
  /** Members by status. A child that failed counts as `failed`, though its checkpoint is `completed`. */
  counts: Partial<Record<StepCheckpoint['status'], number>>;
  startedAt?: Date | undefined;
  finishedAt?: Date | undefined;
  /** The first {@link FAN_SUMMARY_FAILURES} failed members, so a failure shows without paging. */
  failures: StepCheckpoint[];
}

/** A page of one fan's members, in seq order. */
export interface FanPage {
  items: StepCheckpoint[];
  /** Members matching the query, across all pages. */
  total: number;
  /** A validator for this page, when the gateway can compute one without reading the members. */
  etag?: string | undefined;
  /**
   * Set when the query's `ifNoneMatch` matched {@link etag}: the page has not changed, and `items`
   * is empty rather than read.
   */
  notModified?: true | undefined;
}

export interface FanPageQuery {
  offset?: number | undefined;
  limit?: number | undefined;
  /** Only failed members (a failed step, or a child that failed). */
  failedOnly?: boolean | undefined;
  /** An HTTP `If-None-Match` value: a page whose `etag` it names comes back `notModified`. */
  ifNoneMatch?: string | undefined;
}

export const FAN_SUMMARY_FAILURES = 20;
/** The most children a summarized detail lists by id; `childCount` carries the rest. */
export const SUMMARY_CHILD_LIMIT = 200;
const FAN_PAGE_MAX = 500;

/** How many children a folded `fan:` checkpoint stands for; undefined for any other checkpoint. */
export function foldedCount(cp: StepCheckpoint): number | undefined {
  if (!cp.name.startsWith(FOLDED_PREFIX)) return undefined;
  const values = (cp.output as Partial<FoldedChildren> | null | undefined)?.values;
  return Array.isArray(values) ? values.length : 0;
}

/** A failed member: a failed step, or a child whose completion reports `ok: false`. */
export function isFailedMember(cp: StepCheckpoint): boolean {
  if (cp.status === 'failed') return true;
  if (!cp.name.startsWith('signal:child:') || cp.status !== 'completed') return false;
  return (cp.output as { ok?: unknown } | null | undefined)?.ok === false;
}

function fanLabel(members: StepCheckpoint[]): string {
  if (members.some((cp) => cp.name.startsWith('signal:child:') || foldedCount(cp) !== undefined)) {
    return 'child runs';
  }
  const first = members[0]?.name ?? '';
  return members.every((cp) => cp.name === first) ? first : 'steps';
}

/** Summarize one fan's members (in seq order). */
export function summarizeFan(group: string, members: StepCheckpoint[]): FanSummary {
  const counts: FanSummary['counts'] = {};
  const failures: StepCheckpoint[] = [];
  let size = 0;
  let startedAt: Date | undefined;
  let finishedAt: Date | undefined;
  let firstSeq = Number.POSITIVE_INFINITY;
  let lastSeq = Number.NEGATIVE_INFINITY;
  for (const cp of members) {
    firstSeq = Math.min(firstSeq, cp.seq);
    lastSeq = Math.max(lastSeq, cp.seq);
    const folded = foldedCount(cp);
    const n = folded ?? 1;
    size += n;
    const status = isFailedMember(cp) ? 'failed' : cp.status;
    counts[status] = (counts[status] ?? 0) + n;
    if (status === 'failed' && failures.length < FAN_SUMMARY_FAILURES) failures.push(cp);
    if (cp.status !== 'pending' && cp.status !== 'running') {
      if (!startedAt || cp.startedAt < startedAt) startedAt = cp.startedAt;
      if (!finishedAt || cp.finishedAt > finishedAt) finishedAt = cp.finishedAt;
    } else if (!startedAt || cp.enqueuedAt < startedAt) {
      startedAt = cp.enqueuedAt;
    }
  }
  const parsed = parseFanGroup(group);
  const total = parsed?.size;
  return {
    group,
    label: fanLabel(members),
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

/**
 * Split a run's timeline into the checkpoints a detail view lists one by one and the fans it draws as
 * one node each: every `parallelGroup` with more than `over` members, or declared wider than that,
 * becomes a {@link FanSummary}, and its members leave the timeline. Smaller groups and ungrouped steps stay as they are.
 */
export function summarizeTimeline(
  timeline: StepCheckpoint[],
  over: number,
): { timeline: StepCheckpoint[]; fans: FanSummary[] } {
  const byGroup = new Map<string, StepCheckpoint[]>();
  for (const cp of timeline) {
    if (cp.parallelGroup === undefined) continue;
    const members = byGroup.get(cp.parallelGroup);
    if (members) members.push(cp);
    else byGroup.set(cp.parallelGroup, [cp]);
  }
  const summarized = new Set<string>();
  const fans: FanSummary[] = [];
  for (const [group, members] of byGroup) {
    // A fan sent in small waves has few rows yet; its declared size is what makes it wide.
    if (members.length <= over && (parseFanGroup(group)?.size ?? 0) <= over) continue;
    summarized.add(group);
    fans.push(summarizeFan(group, members));
  }
  if (fans.length === 0) return { timeline, fans };
  return {
    timeline: timeline.filter(
      (cp) => cp.parallelGroup === undefined || !summarized.has(cp.parallelGroup),
    ),
    fans: fans.sort((a, b) => a.firstSeq - b.firstSeq),
  };
}

/** One page of a fan's members out of a run's timeline. */
export function pageFan(timeline: StepCheckpoint[], group: string, query: FanPageQuery): FanPage {
  const matching = timeline.filter(
    (cp) => cp.parallelGroup === group && (!query.failedOnly || isFailedMember(cp)),
  );
  const { offset, limit } = fanPageBounds(query);
  return { items: matching.slice(offset, offset + limit), total: matching.length };
}

/** A {@link FanPageQuery}'s offset and limit, clamped to sane bounds. */
export function fanPageBounds(query: FanPageQuery): { offset: number; limit: number } {
  const offset =
    query.offset !== undefined && Number.isFinite(query.offset)
      ? Math.max(0, Math.floor(query.offset))
      : 0;
  const limit =
    query.limit !== undefined && Number.isFinite(query.limit)
      ? Math.min(FAN_PAGE_MAX, Math.max(1, Math.floor(query.limit)))
      : 100;
  return { offset, limit };
}
