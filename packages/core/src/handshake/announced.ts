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
 * The announcer is always the process that CONSUMES the queue, never the engine that dispatches to
 * it — including when the two share a process (the co-located in-app worker announces; the engine
 * beside it does not). One consequence is worth stating plainly rather than leaving to be
 * rediscovered: a pure operator (`store` with no `connection`) runs its bodies inline, consumes no
 * queue, and therefore announces NOTHING. Its workflows are real and startable through its own
 * `start()`, but they are not in this registry, because nothing about them is externally addressable
 * for a picker to point at.
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
 *
 * ## The floor: a live worker that announces nothing
 *
 * An SDK old enough to predate the descriptor advertisement publishes only its TTL'd liveness
 * heartbeat — one key per routing token it consumes. Read strictly, such a fleet announces nothing
 * and this registry would be empty while work is being served. That answer is not merely unhelpful,
 * it CONTRADICTS the engine beside it: `resolveRemoteByConvention` routes a call to `X` the moment a
 * token named `X` heartbeats, so the deployment already treats liveness as sufficient to CALL a
 * workflow while claiming to know nothing when asked to LIST one. Both answers come out of the same
 * Redis.
 *
 * So the heartbeat is folded in as a second, weaker tier of evidence ({@link AnnouncedWorkflow.evidence}
 * `'observed'`): the entry exists because a live token of that name exists, which is exactly — no more
 * and no less — the condition under which convention routing would resolve it. Listing it therefore
 * cannot introduce a failure the dispatcher did not already have. What it CANNOT do is state a
 * version, an origin, a runtime, or even that the token serves a workflow rather than a step handler
 * of the same name: none of that is in a heartbeat, and every one of those stays un-stated rather than
 * being guessed. A descriptor always wins — a token an announcement already covers is never re-added
 * as an observation.
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

/**
 * How strong the fleet's claim about a workflow is. The two tiers are NOT interchangeable and a
 * caller must not read them as the same fact:
 *
 * - `'declared'` — at least one live worker published a descriptor naming this workflow. Everything
 *   populated on the entry was STATED by that worker; everything absent it declined to state.
 * - `'observed'` — nobody described it. What exists is a live routing token of this name, which is
 *   precisely the condition `resolveRemoteByConvention` uses to route a call, so the name IS
 *   reachable. Nothing else is known: no version, no origin, no runtime, and no assurance that the
 *   worker consuming that token serves a WORKFLOW there rather than a step handler of the same name.
 *   An entry like this is a live queue, not a promise.
 */
export type AnnouncementEvidence = 'declared' | 'observed';

/** One workflow the live fleet announces, folded across every worker that announced it. */
export interface AnnouncedWorkflow {
  /** What kind of claim this entry rests on — see {@link AnnouncementEvidence}. A caller that shows
   *  a version, an origin or a runtime must check this first: an `'observed'` entry has none of
   *  them, and the emptiness is a fact about the fleet, not a rendering gap. */
  evidence: AnnouncementEvidence;
  /** `name@version`, or the bare `name` when no announcer stated a version. Stable sort key. */
  key: string;
  name: string;
  /** Absent when no announcer stated one — never inferred from another announcer's version. */
  version?: string;
  /** Every distinct routing group announced (sorted). Empty = nobody stated one. On an `'observed'`
   *  entry this is the token the heartbeat was published UNDER — not a claim by anybody, but the
   *  queue a call would actually land on, which is the one thing an observation does establish. */
  groups: string[];
  /** Every distinct declaring package announced (sorted). Empty = nobody stated one. */
  origins: string[];
  /** Every distinct capability demand announced, each de-duplicated + sorted. Empty = nobody stated
   *  one. Two entries here means two workers demand different capabilities for the same version. */
  requires: string[][];
  /** Runtimes of the live announcers (sorted, de-duplicated). EMPTY on an `'observed'` entry: a
   *  heartbeat does not say what runtime wrote it, and the instance id's shape is a convention, not
   *  a statement, so it is not read as one. */
  runtimes: ('node' | 'python')[];
  /** Instance ids of the live workers announcing it (sorted, de-duplicated). Its length is how many
   *  workers can currently run this workflow — `1` is a single point of failure, and it is never 0
   *  (an entry exists only because somebody announced it, or because somebody is beating on it). */
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
      evidence: 'declared',
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

/**
 * The part of one live worker heartbeat this registry can read: the routing token the beat was
 * published under, and which process published it. That is genuinely all a heartbeat holds — it is
 * the cheap tier of the two-tier advertisement, and its job is liveness, not description.
 *
 * Structurally satisfied by `WorkerHeartbeat` (the transport-facing shape, which also carries a beat
 * time and an execution snapshot). Declared here rather than imported so this module keeps its "pure
 * data, no transport" footing and `interfaces.ts` can keep importing FROM it.
 */
export interface HeartbeatSighting {
  /** The routing token the beat was published under (already partition-suffixed when partitioned). */
  group: string;
  /** The beating process's instance id. */
  instanceId: string;
}

/**
 * The weaker tier: one entry per live routing token that NO descriptor accounts for.
 *
 * `covered` holds every token the declared announcements already explain — both the sanitized form of
 * each announced NAME and every group any announcer stated. A token in that set is dropped, so a
 * fleet that describes itself properly gets exactly the same registry it got before this tier
 * existed, and a worker is never counted twice under two kinds of evidence.
 *
 * Everything an observation cannot know stays empty rather than being filled with a plausible guess:
 * no version (so nothing can be pinned against it), no origin, no requires, no runtime. The `name` is
 * the token itself, which equals the workflow's name for every name a queue token can round-trip —
 * `sanitizeQueueToken` rewrites `:` to `-` and that rewrite is not invertible, so a workflow named
 * `orders:fulfill` is observed as `orders-fulfill`. Stated here because a picker showing that string
 * should show what the queue is really called, not a reconstruction that might be wrong.
 */
export function observedAnnouncements(
  heartbeats: readonly HeartbeatSighting[],
  covered: ReadonlySet<string>,
): AnnouncedWorkflow[] {
  const byToken = new Map<string, Set<string>>();
  for (const beat of heartbeats) {
    if (!beat.group || covered.has(beat.group)) continue;
    const instances = byToken.get(beat.group);
    if (instances) instances.add(beat.instanceId);
    else byToken.set(beat.group, new Set([beat.instanceId]));
  }
  return [...byToken.entries()]
    .map(([group, instances]) => ({
      evidence: 'observed' as const,
      key: group,
      name: group,
      groups: [group],
      origins: [],
      requires: [],
      runtimes: [],
      instances: [...instances].sort(),
      disagreements: [],
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Every routing token the DECLARED announcements already account for — the announced names in their
 *  queue-token form plus every group an announcer stated. `sanitize` is injected so this module keeps
 *  no dependency on the queue layer. */
export function coveredTokens(
  announced: readonly AnnouncedWorkflow[],
  sanitize: (name: string) => string,
): Set<string> {
  const tokens = new Set<string>();
  for (const entry of announced) {
    tokens.add(sanitize(entry.name));
    for (const group of entry.groups) tokens.add(group);
  }
  return tokens;
}
