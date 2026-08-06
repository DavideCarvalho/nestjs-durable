/**
 * The announced workflow registry (design §7.9) — the aggregate answer to "what workflows exist in
 * this deployment?", built ONLY from what live workers say about themselves.
 *
 * ## Why this is announced, not inferred
 *
 * `WorkflowEngine.workflowBody(name, version)` answers for the process that asks, and a missing body
 * is ambiguous by design: it means "not registered here", but equally "registered via
 * `registerRemote` against another SDK" or "a group this pod resolves by convention against a live
 * worker". A picker built on that inference would offer different options depending on which replica
 * served the request. So the registry is not derived from any engine's registry: a worker publishes
 * what it can execute ({@link WorkerDescriptor.registrations}, or bare `workflows` names), and this
 * module folds those statements together. Every entry is therefore a fact somebody asserted, and the
 * aggregate is the same on every pod because every pod reads the same published statements.
 *
 * ## Liveness
 *
 * There is no expiry logic here because there is no state here. An announcement lives on the
 * descriptor key, which is written with the worker-heartbeat TTL and refreshed by the same beat; a
 * worker that dies stops refreshing and its key expires, taking its announcements with it. The
 * resolution of that liveness is therefore the TTL (35s against a 10s beat), so an entry can name a
 * worker that died within the last beat window — the same staleness the capability router already
 * accepts when it reads descriptors to decide whether to dispatch. A caller that needs a stronger
 * guarantee should not seek it here: dispatch to a dead worker parks the run `blocked`/`pending` on
 * its queue and the existing worker-health surface reports it. What this design DOES rule out is the
 * unbounded failure — an announcement that outlives its worker forever.
 *
 * ## Disagreement
 *
 * Two live workers can announce the same `name@version` with different groups, origins or capability
 * demands. The aggregate keeps EVERY distinct claim and reports the axes they differ on
 * ({@link AnnouncedWorkflow.disagreements}); it never merges them into one value and never picks a
 * winner, because either choice would make a caller act on a claim nobody made. Silence is not a
 * claim: a worker that announced no origin does not disagree with one that did.
 *
 * ## Steps are deliberately out of scope
 *
 * There is no equivalent registry for steps, and this is not an omission to be fixed later. A step is
 * not addressable from outside a run: it is identified by its `(runId, seq)` position in one
 * workflow's history, `ctx.step` is only callable from inside a replaying body, and no engine entry
 * point starts a step on its own. "Call this step" is therefore not something the engine can do, so a
 * picker offering steps would be offering an operation that does not exist. Step HANDLER names are
 * still advertised (`WorkerDescriptor.steps`) — that is a routing/capability fact used to decide
 * whether a dispatched step can be run, not an invocable catalog.
 */

import type { RawWorkerDescriptor, WorkerDescriptor, WorkflowRegistration } from './descriptor';
import { normalizeDescriptor } from './descriptor';

/** One live worker's claim about one workflow: the registration plus who announced it. */
export interface WorkflowAnnouncement extends WorkflowRegistration {
  /** The announcing worker's instance id. */
  instanceId: string;
  /** The announcing worker's runtime — how a Python-served workflow is told from a Node-served one. */
  runtime: 'node' | 'python';
}

/** An axis on which the live announcers of one workflow do not agree. `values` holds every distinct
 *  DECLARED value (sorted); an announcer that stated nothing on the axis contributes nothing. */
export interface Disagreement {
  axis: 'group' | 'origin' | 'requires';
  values: string[];
}

/** One workflow the live fleet announces, folded across every worker that announced it. */
export interface AnnouncedWorkflow {
  /** `name@version`, or the bare `name` when no announcer stated a version. Stable sort key. */
  key: string;
  name: string;
  /** Absent when no announcer stated one — never inferred from another announcer's version. */
  version?: string;
  /** Every distinct routing group announced (sorted). Empty = nobody stated one. */
  groups: string[];
  /** Every distinct declaring package announced (sorted). Empty = nobody stated one. */
  origins: string[];
  /** Every distinct capability demand announced, each de-duplicated + sorted. Empty = nobody stated
   *  one. Two entries here means two workers demand different capabilities for the same version. */
  requires: string[][];
  /** Runtimes of the live announcers (sorted, de-duplicated). */
  runtimes: ('node' | 'python')[];
  /** Instance ids of the live workers announcing it (sorted, de-duplicated). Its length is how many
   *  workers can currently run this workflow — `1` is a single point of failure, and it is never 0
   *  (an entry exists only because somebody announced it). */
  instances: string[];
  /** The axes the announcers differ on, empty when they speak with one voice. A caller that must
   *  pick a single target has to resolve these itself — the registry refuses to guess. */
  disagreements: Disagreement[];
}

/**
 * What one descriptor announces. `registrations` is authoritative when present; any `workflows` name
 * it does not cover is still announced as a bare, unversioned claim, so a worker that describes some
 * of its workflows richly and others by name alone is reported in full rather than in part.
 *
 * A descriptor with neither field announces nothing — including the control plane's own descriptor,
 * which is a router, not an executor.
 */
export function announcementsOf(
  raw: RawWorkerDescriptor | WorkerDescriptor,
): WorkflowAnnouncement[] {
  const d = normalizeDescriptor(raw);
  const identity = { instanceId: d.instanceId, runtime: d.runtime };
  const announcements = (d.registrations ?? []).map((reg) => ({ ...reg, ...identity }));
  const covered = new Set(announcements.map((a) => a.name));
  for (const name of d.workflows) {
    if (!covered.has(name)) announcements.push({ name, ...identity });
  }
  return announcements;
}

/** `name@version`, or the bare name when unversioned — the identity two announcements are folded on. */
function announcementKey(a: WorkflowRegistration): string {
  return a.version === undefined ? a.name : `${a.name}@${a.version}`;
}

/** Sorted, de-duplicated members of `values`, dropping the un-stated ones. */
function stated(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== undefined))].sort();
}

/**
 * Fold every live descriptor's announcements into one entry per `name@version`, sorted by key.
 *
 * Pure: it holds nothing and caches nothing, so no pod ever carries a growing table of the fleet's
 * registrations — the caller reads the live descriptors it already knows how to read, folds them
 * here, and drops the result. The work is O(descriptors × announcements) per call, on demand.
 *
 * The same instance announcing the same workflow twice (a worker publishes its descriptor under
 * every routing token it consumes, so the same bytes arrive several times) folds to ONE announcer:
 * `instances` is a set, so it counts workers, not keys.
 */
export function aggregateAnnouncements(
  descriptors: readonly (RawWorkerDescriptor | WorkerDescriptor)[],
): AnnouncedWorkflow[] {
  const byKey = new Map<string, WorkflowAnnouncement[]>();
  for (const descriptor of descriptors) {
    for (const announcement of announcementsOf(descriptor)) {
      const key = announcementKey(announcement);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(announcement);
      else byKey.set(key, [announcement]);
    }
  }

  const out: AnnouncedWorkflow[] = [];
  for (const [key, announcements] of byKey) {
    const groups = stated(announcements.map((a) => a.group));
    const origins = stated(announcements.map((a) => a.origin));
    // A capability demand is a SET, so it is compared as its canonical (sorted, de-duplicated) form:
    // two workers demanding ['saga','signals'] and ['signals','saga'] agree, and must not be reported
    // as a disagreement over the same demand written two ways.
    const requiresByJson = new Map<string, string[]>();
    for (const a of announcements) {
      if (a.requires === undefined) continue;
      const canonical = [...new Set(a.requires)].sort();
      requiresByJson.set(JSON.stringify(canonical), canonical);
    }
    // Ordered by the same rendering `disagreements` uses, so the two lists read in step.
    const requires = [...requiresByJson.values()].sort((x, y) =>
      x.join(',').localeCompare(y.join(',')),
    );

    const disagreements: Disagreement[] = [];
    if (groups.length > 1) disagreements.push({ axis: 'group', values: groups });
    if (origins.length > 1) disagreements.push({ axis: 'origin', values: origins });
    if (requires.length > 1) {
      disagreements.push({ axis: 'requires', values: requires.map((r) => r.join(',')) });
    }

    const first = announcements[0];
    if (!first) continue;
    out.push({
      key,
      name: first.name,
      ...(first.version !== undefined ? { version: first.version } : {}),
      groups,
      origins,
      requires,
      runtimes: [...new Set(announcements.map((a) => a.runtime))].sort(),
      instances: [...new Set(announcements.map((a) => a.instanceId))].sort(),
      disagreements,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
