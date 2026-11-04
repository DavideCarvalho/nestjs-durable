import type { RunStatus, SearchAttributes, StepError, WorkflowRun } from './interfaces';
import {
  type WorkflowInputOf,
  type WorkflowOutputOf,
  type WorkflowRef,
  workflowName,
} from './workflow-ref';

/**
 * Lifecycle events: when a run settles, the engine publishes `run.completed:<workflow>` or
 * `run.failed:<workflow>` on the same bus as `publishEvent`, so another workflow can start on it
 * through `onEvent` (or `@OnWorkflowCompleted` / `@OnWorkflowFailed` in `@dudousxd/nestjs-durable`)
 * without the settling workflow knowing it exists.
 *
 * Delivery is exactly once per subscriber and settled run. The terminal status write also tags the
 * run {@link LIFECYCLE_PENDING_TAG} plus one {@link LIFECYCLE_OWED_TAG_PREFIX} tag per subscriber
 * the event is owed to: the ones registered on the settling process and the ones live workers
 * announce. A process that dies before publishing, or that does not have a subscriber, leaves the
 * marker for the timer poller's lifecycle sweep on any instance that does; the subscriber's run id
 * is deterministic ({@link lifecycleRunId}), so publishing twice starts it once.
 *
 * When the settling process has no usable read of the fleet's announcements (none yet, or the last
 * one failed), the terminal write tags the run {@link LIFECYCLE_PENDING_TAG} alone: the owed set is
 * unresolved, and the first publish with a good read resolves it. A subscriber announced after the
 * run settled is caught by the sweep's heal pass for {@link LIFECYCLE_HEAL_WINDOW_MS}; later than
 * that, `engine.republishLifecycle` backfills it.
 */

/** The event published when a run of `workflow` completes. */
export function runCompletedEvent(workflow: WorkflowRef): string {
  return `run.completed:${workflowName(workflow)}`;
}

/** The event published when a run of `workflow` ends failed, cancelled or dead. */
export function runFailedEvent(workflow: WorkflowRef): string {
  return `run.failed:${workflowName(workflow)}`;
}

/**
 * Tag written with a run's terminal status when some workflow subscribes to its lifecycle event,
 * and removed once the event is published. A settled run still carrying it was never published.
 * Carried with no {@link LIFECYCLE_OWED_TAG_PREFIX} tag, it means the owed set is unresolved: the
 * settling process could not read the fleet's announcements, so the run is owed to every subscriber
 * the first publish with a good read finds (minus the ones already started or failed).
 */
export const LIFECYCLE_PENDING_TAG = 'durable:lifecycle:pending';

/**
 * Whether a run's `tags` (an array, or the JSON text a raw SQL select returns) still carry
 * {@link LIFECYCLE_PENDING_TAG}. Retention never prunes such a run: its lifecycle event is owed.
 */
export function carriesLifecyclePending(tags: unknown): boolean {
  if (Array.isArray(tags)) return tags.includes(LIFECYCLE_PENDING_TAG);
  if (typeof tags === 'string') return tags.includes(`"${LIFECYCLE_PENDING_TAG}"`);
  return false;
}

/** Prefix of the tags naming the subscribers a settled run started (`durable:triggered:<workflow>`). */
export const LIFECYCLE_TRIGGERED_TAG_PREFIX = 'durable:triggered:';

/**
 * Prefix of the tags naming each subscriber a settled run's lifecycle event is still owed to
 * (`durable:lifecycle:owed:<workflow>`). Written with {@link LIFECYCLE_PENDING_TAG} and removed one
 * by one as the instances holding each subscriber publish to it; the pending tag goes with the last.
 */
export const LIFECYCLE_OWED_TAG_PREFIX = 'durable:lifecycle:owed:';

/**
 * How long after a run settled an owed subscriber that no live worker announces and the sweeping
 * instance does not have is kept. Past it the sweep drops the owed tag and reports
 * `run.trigger_failed`, so a removed subscriber cannot keep a run from being pruned forever.
 */
export const LIFECYCLE_ORPHAN_MS = 24 * 60 * 60 * 1000;

/**
 * Prefix of the tags naming each subscriber whose start from a settled run's lifecycle event failed
 * (`durable:trigger_failed:<workflow>`): its `where` threw, its input was rejected, its start threw,
 * or the sweep dropped it as orphaned (see {@link LIFECYCLE_ORPHAN_MS}). Written in the same update
 * that drops its owed tag, and removed by the update that records it started. The failure message
 * is not stored; the `run.trigger_failed` event carries it.
 */
export const LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX = 'durable:trigger_failed:';

/** The subscribers whose start from a run's lifecycle event failed, read from its failed tags. */
export function triggerFailedSubscribersOf(tags: readonly string[] | undefined): string[] {
  return (tags ?? [])
    .filter((tag) => tag.startsWith(LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX))
    .map((tag) => tag.slice(LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX.length));
}

/** The subscribers a settled run started, read from its {@link LIFECYCLE_TRIGGERED_TAG_PREFIX} tags. */
export function triggeredSubscribersOf(tags: readonly string[] | undefined): string[] {
  return (tags ?? [])
    .filter((tag) => tag.startsWith(LIFECYCLE_TRIGGERED_TAG_PREFIX))
    .map((tag) => tag.slice(LIFECYCLE_TRIGGERED_TAG_PREFIX.length));
}

/**
 * Prefix of the tags naming each subscriber a settled run's lifecycle event was routed into a
 * debounce/batch accumulator for (`durable:coalesced:<workflow>`). Such a subscriber starts no run
 * of the source's id, so this tag is what records the delivery: written in the same update that drops
 * its owed tag, it keeps a heal or a republish from routing the event again.
 */
export const LIFECYCLE_COALESCED_TAG_PREFIX = 'durable:coalesced:';

/** The subscribers a settled run's event was coalesced into, read from its coalesced tags. */
export function coalescedSubscribersOf(tags: readonly string[] | undefined): string[] {
  return (tags ?? [])
    .filter((tag) => tag.startsWith(LIFECYCLE_COALESCED_TAG_PREFIX))
    .map((tag) => tag.slice(LIFECYCLE_COALESCED_TAG_PREFIX.length));
}

/**
 * How long after a run settled the lifecycle sweep still checks it for subscribers it missed: one
 * the fleet announced only after the settling process last read the announcements. Such a
 * subscriber is started (or owed to the instances that have it) as if it had been owed from the
 * start. One announced later than this is backfill, for `engine.republishLifecycle`.
 */
export const LIFECYCLE_HEAL_WINDOW_MS = 2 * 60 * 1000;

/** The subscribers a run's lifecycle event is still owed to, read from its owed tags. */
export function owedSubscribersOf(tags: readonly string[] | undefined): string[] {
  return (tags ?? [])
    .filter((tag) => tag.startsWith(LIFECYCLE_OWED_TAG_PREFIX))
    .map((tag) => tag.slice(LIFECYCLE_OWED_TAG_PREFIX.length));
}

/**
 * Prefix of the tag holding the W3C `traceparent` of a run's root span
 * (`durable:lifecycle:trace:<traceparent>`). Written with the run's first suspend, or with the
 * lifecycle marker when it settles without suspending, when some workflow subscribes to the run's
 * ending and the engine has a run trace provider (see `WorkflowEngine.setRunTraceparent`), so a
 * subscriber's trace can link to its source run from any process.
 */
export const LIFECYCLE_TRACE_TAG_PREFIX = 'durable:lifecycle:trace:';

/** The traceparent a settled run recorded in its {@link LIFECYCLE_TRACE_TAG_PREFIX} tag, if any. */
export function lifecycleTraceparentOf(tags: readonly string[] | undefined): string | undefined {
  const tag = (tags ?? []).find((t) => t.startsWith(LIFECYCLE_TRACE_TAG_PREFIX));
  return tag?.slice(LIFECYCLE_TRACE_TAG_PREFIX.length) || undefined;
}

/** Whether `tag` is one the engine writes for lifecycle bookkeeping rather than one the run was given. */
export function isLifecycleTag(tag: string): boolean {
  return (
    tag === LIFECYCLE_PENDING_TAG ||
    tag.startsWith(LIFECYCLE_OWED_TAG_PREFIX) ||
    tag.startsWith(LIFECYCLE_TRIGGERED_TAG_PREFIX) ||
    tag.startsWith(LIFECYCLE_COALESCED_TAG_PREFIX) ||
    tag.startsWith(LIFECYCLE_TRIGGER_FAILED_TAG_PREFIX) ||
    tag.startsWith(LIFECYCLE_TRACE_TAG_PREFIX)
  );
}

/** The payload of a lifecycle event, read from the store after the run settled. */
export interface WorkflowLifecycleEvent<TInput = unknown, TOutput = unknown> {
  runId: string;
  workflow: string;
  workflowVersion: string;
  /** `completed` on `run.completed:*`; `failed`, `cancelled` or `dead` on `run.failed:*`. */
  status: RunStatus;
  namespace?: string | undefined;
  input: TInput;
  /** Present on a completed run. */
  output?: TOutput | undefined;
  /** Present on a run that did not complete. */
  error?: StepError | undefined;
  tags?: string[] | undefined;
  searchAttributes?: SearchAttributes | undefined;
}

/** The lifecycle event a run of workflow class `C` publishes, typed by its input and output. */
export type LifecycleEventOf<C> = WorkflowLifecycleEvent<WorkflowInputOf<C>, WorkflowOutputOf<C>>;

/** Which lifecycle event a settled run publishes: `completed`, or `failed` for any other ending. */
export type LifecycleKind = 'completed' | 'failed';

/**
 * The id of the run a lifecycle event starts for `subscriber`. Deterministic, so the same settled
 * run never starts the same subscriber twice, and either side of the link can be found from the other.
 */
export function lifecycleRunId(
  sourceRunId: string,
  kind: LifecycleKind,
  subscriber: string,
): string {
  return `evt:${sourceRunId}:${kind}:${subscriber}`;
}

/** The lifecycle event a run in `status` published, or undefined while it has not settled. */
export function lifecycleKindOf(status: RunStatus | undefined): LifecycleKind | undefined {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled' || status === 'dead') return 'failed';
  return undefined;
}

/** The event name a run of `workflow` publishes when it settles as `kind`. */
export function lifecycleEventName(workflow: string, kind: LifecycleKind): string {
  return kind === 'completed' ? runCompletedEvent(workflow) : runFailedEvent(workflow);
}

/** The workflow and ending a lifecycle event name stands for, or undefined for any other event. */
export function parseLifecycleEvent(
  event: string,
): { workflow: string; kind: LifecycleKind } | undefined {
  for (const kind of ['completed', 'failed'] as const) {
    const prefix = `run.${kind}:`;
    if (event.startsWith(prefix) && event.length > prefix.length) {
      return { workflow: event.slice(prefix.length), kind };
    }
  }
  return undefined;
}

/**
 * One workflow that starts when another settles, as the dashboard's workflow page lists it. `local`
 * is what the answering instance has registered, with what its subscription does to the payload;
 * an entry only live workers announce (a Python subscriber, or a TypeScript one served elsewhere)
 * states none of that, since the announcement carries only the event name.
 */
export interface LifecycleSubscriptionLink {
  /** The other end: the subscriber on `startsOnSettle`, the settling workflow on `startedBy`. */
  workflow: string;
  kind: LifecycleKind;
  /** Registered on the answering instance (true) or only announced by live workers (false). */
  local: boolean;
  /** Announced by at least one live worker. */
  announced: boolean;
  /** The subscription filters payloads with `where`. */
  where: boolean;
  /** The subscription maps the payload to the run's input with `input`. */
  input: boolean;
  /** The subscriber coalesces events: debounced or batched, and whether per `key`. */
  coalesce?: { mode: 'debounce' | 'batch'; keyed: boolean } | undefined;
}

/**
 * Who starts whom through lifecycle events, for one workflow: the subscribers of its
 * `run.completed:<workflow>` / `run.failed:<workflow>` events, and the workflows whose settling
 * starts it. Built from the answering instance's registry and the subscriptions live workers
 * announce.
 */
export interface WorkflowLifecycleLinks {
  workflow: string;
  /** Workflows that start when this one settles, sorted by workflow then kind. */
  startsOnSettle: LifecycleSubscriptionLink[];
  /** Workflows whose settling starts this one, sorted by workflow then kind. */
  startedBy: LifecycleSubscriptionLink[];
}

/**
 * The run whose settling started `run`, when a lifecycle event started it. Read from the run's id,
 * which ends in `:<kind>:<its own workflow>`, so it holds whatever input the subscriber was given.
 */
export function lifecycleSourceOf(run: {
  id: string;
  workflow: string;
}): { runId: string; kind: LifecycleKind } | undefined {
  if (!run.id.startsWith('evt:')) return undefined;
  for (const kind of ['completed', 'failed'] as const) {
    const suffix = `:${kind}:${run.workflow}`;
    if (run.id.endsWith(suffix) && run.id.length > 'evt:'.length + suffix.length) {
      return { runId: run.id.slice('evt:'.length, -suffix.length), kind };
    }
  }
  return undefined;
}

/**
 * The runs `run`'s settling started, read from its {@link LIFECYCLE_TRIGGERED_TAG_PREFIX} tags.
 * Empty for a run that has not settled or started nobody. Needs no subscriber registry, so any
 * process holding the run row can answer it.
 */
export function triggeredRunsOf(run: Pick<WorkflowRun, 'id' | 'status' | 'tags'>): string[] {
  const kind = lifecycleKindOf(run.status);
  if (!kind) return [];
  return (run.tags ?? [])
    .filter((tag) => tag.startsWith(LIFECYCLE_TRIGGERED_TAG_PREFIX))
    .map((tag) => lifecycleRunId(run.id, kind, tag.slice(LIFECYCLE_TRIGGERED_TAG_PREFIX.length)));
}

/** The {@link WorkflowLifecycleEvent} a settled run publishes. */
export function lifecycleEventOf(run: WorkflowRun): WorkflowLifecycleEvent {
  const completed = run.status === 'completed';
  return {
    runId: run.id,
    workflow: run.workflow,
    workflowVersion: run.workflowVersion,
    status: run.status,
    namespace: run.namespace,
    input: run.input,
    ...(completed ? { output: run.output } : { error: run.error }),
    tags: run.tags?.filter((tag) => !isLifecycleTag(tag)),
    searchAttributes: run.searchAttributes,
  };
}

/**
 * Which settled runs `engine.republishLifecycle` publishes again: one run, or the settled runs of a
 * workflow (`kind` narrows to completed or to every other ending; `since`/`until` bound when they
 * settled; `limit` caps how many runs are read, default 1000; `namespace` reads one namespace only,
 * the engine's own when unset). `subscriber` restricts it to one subscribing workflow.
 */
export type RepublishLifecycleTarget =
  | { runId: string; subscriber?: string | undefined }
  | {
      workflow: string;
      kind?: LifecycleKind | undefined;
      since?: Date | undefined;
      until?: Date | undefined;
      subscriber?: string | undefined;
      limit?: number | undefined;
      namespace?: string | undefined;
    };

/** What `engine.republishLifecycle` did: runs published, subscriber runs started, and the failures. */
export interface RepublishLifecycleResult {
  runs: number;
  started: number;
  failed: { runId: string; subscriber: string; error: string }[];
}

/**
 * The internal workflow whose runs make up the lifecycle subscription registry: one completed run
 * per engine instance that has `onEvent` subscriptions, id {@link lifecycleRegistryRunId}, its
 * subscriptions in `input` ({@link LifecycleRegistryEntry}) and its `updatedAt` the heartbeat. Kept
 * in the state store, so an instance learns what the others subscribe to over any transport.
 */
export const LIFECYCLE_REGISTRY_WORKFLOW = '__lifecycle_registry';

/** Tag every registry run carries. Retention never prunes a run that has it. */
export const LIFECYCLE_REGISTRY_TAG = 'durable:lifecycle:registry';

/** How often an engine refreshes its registry run (from the timer poller's lifecycle sweep). */
export const LIFECYCLE_REGISTRY_HEARTBEAT_MS = 10_000;

/** How long after its last heartbeat a registry run still counts as a live instance's. */
export const LIFECYCLE_REGISTRY_TTL_MS = 35_000;

/** How long after its last heartbeat a registry run is deleted, by any engine's sweep. */
export const LIFECYCLE_REGISTRY_STALE_MS = 10 * 60 * 1000;

/** The id of the registry run of engine instance `instanceId`. */
export function lifecycleRegistryRunId(instanceId: string): string {
  return `${LIFECYCLE_REGISTRY_WORKFLOW}:${instanceId}`;
}

/** What a registry run holds in `input`: the `onEvent` subscriptions of one engine instance. */
export interface LifecycleRegistryEntry {
  instanceId: string;
  runtime: 'node';
  /**
   * The engine's namespace, or `null` for an engine with no namespace. Recorded because both write
   * the registry run under `default`. An engine with no namespace sweeps and starts its subscribers
   * for the runs of every namespace, so its subscriptions are owed by settled runs of any namespace;
   * an engine with one, only by its own.
   */
  engineNamespace: string | null;
  /** Each subscribing workflow with the event names it starts on, lifecycle ones included. */
  subscriptions: { workflow: string; events: string[] }[];
}

/**
 * The namespace whose settled runs owe their lifecycle events to the subscriptions of a registry
 * run, or `null` for every namespace: the entry's `engineNamespace`, or for a row written without it,
 * the row's `namespace`, read as every namespace when that is `default` (an engine with no namespace
 * wrote it, as far as the row can tell).
 */
export function lifecycleRegistryNamespace(
  input: unknown,
  rowNamespace: string | undefined,
): string | null {
  const engineNamespace = (input as { engineNamespace?: unknown } | null | undefined)
    ?.engineNamespace;
  if (engineNamespace === null) return null;
  if (typeof engineNamespace === 'string') return engineNamespace || 'default';
  const row = rowNamespace || 'default';
  return row === 'default' ? null : row;
}

/** The subscriptions a registry run's `input` holds; malformed entries are skipped. */
export function lifecycleRegistrySubscriptions(
  input: unknown,
): { workflow: string; events: string[] }[] {
  const subscriptions = (input as Partial<LifecycleRegistryEntry> | null | undefined)
    ?.subscriptions;
  if (!Array.isArray(subscriptions)) return [];
  return subscriptions.flatMap((entry) => {
    const { workflow, events } = (entry ?? {}) as { workflow?: unknown; events?: unknown };
    if (typeof workflow !== 'string' || !Array.isArray(events)) return [];
    return [{ workflow, events: events.filter((e): e is string => typeof e === 'string') }];
  });
}

/**
 * Whether retention must keep a run with these `tags` (an array, or the JSON text a raw SQL select
 * returns): its lifecycle event is still owed ({@link carriesLifecyclePending}), or it is a
 * lifecycle registry run ({@link LIFECYCLE_REGISTRY_TAG}).
 */
export function retentionKeeps(tags: unknown): boolean {
  if (carriesLifecyclePending(tags)) return true;
  if (Array.isArray(tags)) return tags.includes(LIFECYCLE_REGISTRY_TAG);
  if (typeof tags === 'string') return tags.includes(`"${LIFECYCLE_REGISTRY_TAG}"`);
  return false;
}
