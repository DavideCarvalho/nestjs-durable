import {
  type ConcurrencyConfig,
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type EventBatchConfig,
  type LifecycleEventOf,
  type OnErrorInput,
  type OnEventEntry,
  type SearchAttributesSchema,
  type SingletonConfig,
  type StepConfig,
  type StepError,
  WORKFLOW_NAME_KEY,
  type WorkflowClass,
  type WorkflowCtx,
  type WorkflowLifecycleEvent,
  type WorkflowRef,
  parseDuration,
  runCompletedEvent,
  runFailedEvent,
} from '@dudousxd/nestjs-durable-core';
import 'reflect-metadata';
import { declaringFile, rememberDeclaringFile } from './origin';
import type { IoSchema } from './schema-parse';

export const WORKFLOW_METADATA = Symbol('nestjs-durable:workflow');

export interface WorkflowMeta {
  name: string;
  version: string;
  /** The workflow this workflow's dead runs route to (a name or a class). See `WorkflowOptions`. */
  deadLetterWorkflow?: WorkflowRef | undefined;
  /** Where failed runs are routed by error code. See `WorkflowOptions`. */
  onError?: { code?: string | ErrorClassWithCode; workflow: WorkflowRef }[] | undefined;
  /** Static searchable labels stamped on every run of this workflow. See `WorkflowOptions`. */
  tags?: string[] | undefined;
  /** Per-key serialization (a durable mutex). See `WorkflowOptions`. */
  singleton?: SingletonConfig | undefined;
  /** Start-time concurrency quota (rejecting). See `WorkflowOptions`. */
  concurrency?: ConcurrencyConfig | undefined;
  /** Max wall-clock lifetime before a run is cancelled (e.g. `'2h'`). See `WorkflowOptions`. */
  executionTimeout?: string | number | undefined;
  /** Input schema (Standard Schema or DTO class), parsed at start and before every turn. See
   *  `WorkflowOptions`. */
  input?: IoSchema | undefined;
  /** Output schema, parsed before the run completes. See `WorkflowOptions`. */
  output?: IoSchema | undefined;
  /** Custom input validator (throws on invalid). See `WorkflowOptions`. */
  validateInput?: ((input: unknown) => void | Promise<void>) | undefined;
  /** Typed/validated `searchAttributes` shape. See `WorkflowOptions`. */
  searchAttributes?: SearchAttributesSchema | undefined;
  /** Events that start a fresh run of this workflow. See `WorkflowOptions`. */
  onEvent?: OnEventEntry[] | undefined;
  /** Debounce `onEvent` triggers — fire once it's quiet for this long. See `WorkflowOptions`. */
  debounce?: string | number | undefined;
  /** Batch `onEvent` triggers — fire on size or window. See `WorkflowOptions`. */
  batch?: { maxSize: number; within: string | number } | undefined;
  /** Capabilities a live worker must advertise to run this workflow's turns (handshake §7.5). See
   *  `WorkflowOptions`. */
  requires?: string[] | undefined;
}

export interface WorkflowOptions {
  name: string;
  version?: string;
  /**
   * Route this workflow's dead-lettered runs to another **registered** workflow — by class
   * (`deadLetterWorkflow: CheckoutDlqWorkflow`, refactor-safe) or by name for a cross-runtime
   * handler. For a handler co-located on the same class, prefer an inline `@DeadLetter()` method
   * instead — it takes precedence, and declaring both is a boot-time error. The handler receives a
   * {@link DeadLetter} payload, idempotent by a `dlq:<runId>` id.
   */
  deadLetterWorkflow?: WorkflowRef;
  /**
   * Route failed runs of this workflow to other **registered** workflows by error code — the
   * separate-class form of an `@OnError` method (see it for the semantics). Each handler receives an
   * {@link OnErrorInput}; omit `code` for the catch-all. A code routed here and by an `@OnError`
   * method on the class is a boot-time error.
   */
  onError?: { code?: string | ErrorClassWithCode; workflow: WorkflowRef }[];
  /**
   * Static labels stamped on **every run** of this workflow (e.g. `tags: ['etl', 'critical']`) and
   * merged with any per-run tags passed to `start`. Searchable/filterable in the dashboard.
   */
  tags?: string[];
  /**
   * Serialize runs of this workflow that share a key — a durable FIFO mutex. e.g.
   * `singleton: { key: (input) => `base:${input.baseId}` }` runs at most one pipeline per base at a
   * time; same-key runs queue (suspended) and admit in creation order as slots free. `limit` (default
   * 1) raises the concurrency.
   */
  singleton?: SingletonConfig;
  /**
   * A start-time concurrency QUOTA: at most `limit` runs sharing a key in flight, and a start over it
   * is REJECTED (`ConcurrencyLimitError`, nothing created) rather than queued. e.g.
   * `concurrency: { key: (input) => `tenant:${input.tenantId}`, limit: 8 }` caps what one tenant can
   * have executing at once. The key is shared across workflows; `limit` may be a (async) function of
   * the key for per-plan limits; `countStatuses` narrows what occupies a slot (default: every
   * non-terminal status). Use `singleton` instead when excess runs should wait their turn.
   */
  concurrency?: ConcurrencyConfig;
  /**
   * Max wall-clock lifetime for a run of this workflow (e.g. `'2h'`, `'7 days'`, or ms), counted from
   * the run's creation. A run that outlives it is moved to `cancelled` (`execution_timeout`) by the
   * timer poller — whether it is `pending`, `blocked`, `running` or `suspended` — a backstop for runs
   * that get stuck, loop forever or are never picked up. A run in `cancelling` finishes its saga undo
   * instead. Omit for no limit.
   */
  executionTimeout?: string | number;
  /**
   * Capabilities a live worker MUST advertise to run this workflow's turns (handshake design §7.5).
   * Only meaningful for a group-served / remote workflow (an in-app worker or a cross-runtime body):
   * the control-plane dispatches a turn only to a capability-capable + protocol-compatible worker, and
   * if descriptors are published on its group but none qualifies the run parks `blocked` until the
   * recovery poll finds one. Absent/empty = "runs anywhere" (a legacy fleet skips the guard, §7.7).
   */
  requires?: string[];
  /**
   * The run's input schema — a **Standard Schema** (zod 3.24+, valibot, arktype, …) or a
   * **class-validator DTO class** (the same `plainToInstance` + `validate` NestJS's `ValidationPipe`
   * runs; needs the optional peers `class-validator` + `class-transformer`). The same option
   * `@Step({ input })` takes.
   *
   * Parsed at `start`, so invalid input is rejected before any run is created. The run stores the
   * input **as it was sent**; `run(ctx, input)` receives the **parsed** value (coerced/transformed —
   * a `Date` from `z.coerce.date()`, a DTO instance), re-parsed from the stored input before every
   * turn, so a replay sees the same value the first execution did. The schema must therefore be
   * deterministic (no `default(() => Date.now())`), and changing it is a breaking change to the
   * workflow — bump `version`. A stored input that no longer parses fails the run with
   * `code: 'invalid_input'`.
   *
   * `@Workflow({ name: 'checkout', input: CheckoutInput })` or `input: z.object({ … })`.
   */
  input?: IoSchema;
  /**
   * The run's output schema (same forms as {@link input}). The value `run()` returns is parsed before
   * the run completes, and the parsed value is what the run stores as its output. A mismatch fails the
   * run with `code: 'invalid_output'`. The same option `@Step({ output })` takes.
   */
  output?: IoSchema;
  /**
   * A custom check at `start` (throw to reject) for a rule a schema can't express — a cross-field
   * invariant, an async lookup. It runs after `input` parses and receives the parsed value (the input
   * as sent when there is no `input` schema).
   */
  validateInput?: (input: unknown) => void | Promise<void>;
  /**
   * Validate this workflow's {@link WorkflowCtx.upsertSearchAttributes} writes against a **Standard
   * Schema** (https://standardschema.dev — zod 3.24+, valibot, arktype, …). `ctx.upsertSearchAttributes`
   * validates the MERGED result (existing attributes shallow-merged with the patch) on every call —
   * an invalid merge throws a `SchemaValidationError` (code `schema_validation`) naming this workflow,
   * with the schema's issues. The
   * schema's inferred output must be search-attribute-shaped (flat `string`/`number`/`boolean` values
   * only) — a schema whose output has a nested object/array is a compile-time error here. Omit for
   * the prior unvalidated behavior.
   *
   * ```ts
   * import { z } from 'zod';
   *
   * const orderAttrs = z.object({
   *   tier: z.enum(['free', 'pro']),
   *   amount: z.number(),
   * });
   *
   * @Workflow({ name: 'checkout', searchAttributes: orderAttrs })
   * class CheckoutWorkflow {
   *   async run(ctx: WorkflowCtx<InferSearchAttributes<typeof orderAttrs>>, input: CheckoutInput) {
   *     await ctx.upsertSearchAttributes({ tier: input.tier, amount: input.total });
   *   }
   * }
   * ```
   */
  searchAttributes?: SearchAttributesSchema;
  /**
   * Start a fresh run of this workflow whenever any of these events is published via
   * `publishEvent(name, payload)` — the payload becomes the run's input. e.g.
   * `onEvent: ['user.registered', 'user.invited']`. The same subscription can also be declared with
   * the `@OnDurableEvent(...)` class decorator; the two are merged. An entry can also be
   * `{ event, where }`, where `where(payload)` decides per event whether this workflow starts.
   */
  onEvent?: OnEventEntry[];
  /**
   * Coalesce `onEvent` triggers by **debouncing** — start one run only once events have been quiet
   * for this long (resets on each event), with the LAST payload. e.g. `debounce: '30s'`.
   */
  debounce?: string | number;
  /**
   * Coalesce `onEvent` triggers by **batching** — start one run with all payloads (`{ events: [...] }`)
   * once `maxSize` is reached or `within` elapses from the first event. e.g.
   * `batch: { maxSize: 100, within: '10s' }`.
   */
  batch?: { maxSize: number; within: string | number };
}

/**
 * Marks a provider class as a durable workflow. Its `run(ctx, input)` method becomes the
 * workflow function the engine executes and replays.
 */
export function Workflow(options: WorkflowOptions): ClassDecorator {
  // Captured HERE, in the factory, because this is the one moment we are provably executing inside
  // the module that declares the workflow — by the time a registrar scans providers, the only thing
  // left of that module is a class object with no file on it. The path is resolved to the owning
  // package lazily, at registration (see `origin.ts`); a runtime that yields no usable frame simply
  // leaves the workflow unattributed, which the registrar reports at boot.
  const declaredIn = declaringFile(Workflow);
  return (target) => {
    rememberDeclaringFile(target, declaredIn);
    const meta: WorkflowMeta = {
      name: options.name,
      version: options.version ?? '1',
      deadLetterWorkflow: options.deadLetterWorkflow,
      onError: options.onError,
      tags: options.tags,
      singleton: options.singleton,
      concurrency: options.concurrency,
      executionTimeout: options.executionTimeout,
      input: options.input,
      output: options.output,
      validateInput: options.validateInput,
      searchAttributes: options.searchAttributes,
      onEvent: options.onEvent,
      debounce: options.debounce,
      batch: options.batch,
      requires: options.requires,
    };
    Reflect.defineMetadata(WORKFLOW_METADATA, meta, target);
    // Stamp the registered name so this class can be used as a typed workflow ref (ctx.child,
    // engine.start, deadLetterWorkflow) and resolved back to its name via `workflowName`.
    Object.defineProperty(target, WORKFLOW_NAME_KEY, {
      value: options.name,
      configurable: true,
    });
  };
}

// biome-ignore lint/complexity/noBannedTypes: matches reflect-metadata's class target type
export function getWorkflowMeta(target: Function): WorkflowMeta | undefined {
  return Reflect.getMetadata(WORKFLOW_METADATA, target) as WorkflowMeta | undefined;
}

export const DURABLE_STEP_METADATA = Symbol('nestjs-durable:step-handler');

export interface DurableStepMeta {
  /** The resolved routing name — derived (`Class.method`) or explicit, always present. */
  name: string;
  /** Opt-in runtime input schema, validated when the handler is served (see `scanSteps`). Absent on
   *  a bare `@Step()` — compile-time types from the method signature only, no runtime check. */
  input?: IoSchema | undefined;
  /** Opt-in runtime output schema, validated before the handler's result is handed back. */
  output?: IoSchema | undefined;
}

/**
 * `@Step({ name?, input?, output?, retries?, backoff?, backoffMs?, backoffMaxMs?, jitter?,
 * timeoutMs? })` — the object call form. See {@link Step}.
 */
export interface StepOptions {
  /** Explicit routing name, overriding the derived `Class.method`. */
  name?: string;
  /** Runtime input schema, validated at the serve boundary (opt-in — a bare `@Step()` skips it). A
   *  Standard Schema (zod, valibot, …) or a class-validator DTO class — the same forms
   *  `@Workflow({ input })` takes. The method receives the parsed value. */
  input?: IoSchema;
  /** Runtime output schema, validated before the result is returned (opt-in). */
  output?: IoSchema;
  /**
   * Def-level durable-dispatch policy stamped under `DURABLE_STEP_CONFIG` and read by `ctx.step` at
   * the dispatch boundary (see `stepConfigOf`) — a per-call `ctx.step(ref, input, opts)` overrides
   * these field-by-field. Max attempts before the step (and run) fails.
   */
  retries?: number;
  /** How the delay between retries grows: `fixed` (constant) or `exp` (doubles each attempt). */
  backoff?: 'fixed' | 'exp';
  /** Base delay in ms between retries. Omit (or 0) to retry with no delay. */
  backoffMs?: number;
  /** Upper bound on the (exponential) backoff delay. */
  backoffMaxMs?: number;
  /** Add random jitter (50–100% of the computed delay) to avoid thundering-herd retries. */
  jitter?: boolean;
  /**
   * Liveness window for a dispatched step: no result/heartbeat within this many ms presumes the
   * worker dead and fails the dispatch with a `RemoteStepTimeout` (retryable — re-dispatches per
   * `retries`). Omit to wait indefinitely.
   */
  timeoutMs?: number;
  /**
   * Capabilities a live worker MUST advertise to run this step (handshake design §7.5). The
   * control-plane routes the step only to workers whose descriptor advertises every name here; if
   * descriptors are published on the step's group but none is capability-capable + protocol-compatible,
   * the run parks `blocked` (never a silent hang) until the recovery poll finds one. Absent/empty =
   * "runs anywhere" (the default — a legacy fleet publishing no descriptors skips the guard, §7.7). A
   * per-call `ctx.step(ref, input, { requires })` overrides this.
   */
  requires?: string[];
}

/** Build the {@link StepConfig} to stamp under `DURABLE_STEP_CONFIG` from `@Step` options — omitting
 *  every unset field, so a bare `@Step()` (or one with only `name`/`input`/`output`) stamps `undefined`
 *  and leaves `ctx.step` reading nothing but a per-call `opts` override. */
function stepConfigFrom(options: StepOptions): StepConfig | undefined {
  const config: StepConfig = {
    retries: options.retries,
    backoff: options.backoff,
    backoffMs: options.backoffMs,
    backoffMaxMs: options.backoffMaxMs,
    jitter: options.jitter,
    timeoutMs: options.timeoutMs,
    requires: options.requires,
  };
  const hasAnyField = Object.values(config).some((value) => value !== undefined);
  return hasAnyField ? config : undefined;
}

/**
 * Marks a provider method as a durable step handler. An in-process transport (e.g. the
 * event-emitter transport) or a co-located/thin worker runtime routes a dispatched task to it BY
 * NAME — `ctx.step(this.svc.method, input)` reads that same name off the method reference (stamped
 * via the shared, cross-package `DURABLE_STEP_NAME` symbol from `@dudousxd/nestjs-durable-core`), so
 * there's no separately-declared def linking a call site to this handler. The method's single
 * argument is the step input (plus an optional `StepLogger` second arg); its return value is the
 * step output.
 *
 * Three call forms:
 * - `@Step()` — bare: the routing name is DERIVED from the method as `` `${ClassName}.${method}` ``
 *   (e.g. `ExtractionService.runExtractionPage`) — refactor-safe, no magic string.
 * - `@Step('custom:name')` — explicit name override (stable across refactors, or a cross-runtime
 *   contract with a non-JS worker that has no `@Step` of its own).
 * - `@Step({ name?, input?, output?, retries?, backoff?, backoffMs?, backoffMaxMs?, jitter?,
 *   timeoutMs? })` — optional name override, opt-in RUNTIME schemas (a Standard Schema or a DTO
 *   class), and a def-level durable-retry/liveness-timeout policy. `input` validates before the method runs; `output`
 *   validates its return value before it's handed back (see `scanSteps`). `retries`/`backoff`/
 *   `backoffMs`/`backoffMaxMs`/`jitter`/`timeoutMs` are the policy `ctx.step` reads off this method
 *   reference (via `stepConfigOf`) to build the dispatched `StepDef`'s durable retry/backoff and
 *   remote-liveness timeout — a per-call `ctx.step(ref, input, opts)` overrides them field-by-field.
 *   A bare `@Step()` carries none of this and skips validation/retry/timeout — compile-time types
 *   from the method signature are the only check, and the step dispatches with no retry/timeout.
 */
export function Step(nameOrOptions?: string | StepOptions): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor) => {
    const options =
      typeof nameOrOptions === 'string' ? { name: nameOrOptions } : (nameOrOptions ?? {});
    const derivedName = options.name ?? `${target.constructor.name}.${String(propertyKey)}`;
    const meta: DurableStepMeta = {
      name: derivedName,
      input: options.input,
      output: options.output,
    };
    Reflect.defineMetadata(DURABLE_STEP_METADATA, meta, descriptor.value as object);
    // Stamp the SAME resolved name core's `ctx.step` reads off a method reference (`stepNameOf`) —
    // the cross-package contract letting `ctx.step(this.svc.method, input)` route without a
    // separately-declared def. `DURABLE_STEP_NAME` is core's `Symbol.for`-keyed constant, so a
    // duplicate copy of core still reads back the same key (see `step-name-symbol.ts`).
    (descriptor.value as { [DURABLE_STEP_NAME]?: string })[DURABLE_STEP_NAME] = derivedName;
    // Stamp the def-level dispatch policy (retries/backoff/timeoutMs) core's `ctx.step` reads via
    // `stepConfigOf`, under the same `Symbol.for`-keyed contract as `DURABLE_STEP_NAME`. Omitted
    // entirely when no policy field is set, so a bare `@Step()` stamps nothing extra.
    const config = stepConfigFrom(options);
    if (config !== undefined) {
      (descriptor.value as { [DURABLE_STEP_CONFIG]?: StepConfig })[DURABLE_STEP_CONFIG] = config;
    }
    return descriptor;
  };
}

// biome-ignore lint/complexity/noBannedTypes: reflect-metadata reads from the method function
export function getDurableStepMeta(method: Function): DurableStepMeta | undefined {
  return Reflect.getMetadata(DURABLE_STEP_METADATA, method) as DurableStepMeta | undefined;
}

export const DEAD_LETTER_METADATA = Symbol('nestjs-durable:dead-letter');

/**
 * The payload a dead-letter handler receives: the dead run's id, its workflow, the input it was
 * started with (typed via `TInput`), and the failure that killed it.
 */
export interface DeadLetter<TInput = unknown> {
  /** Id of the run that was dead-lettered (inspectable + retriable in the dashboard). */
  deadRunId: string;
  /** Name of the workflow whose run died. */
  workflow: string;
  /** The original input the dead run was started with. */
  input: TInput;
  /** The structured error that moved the run to `dead`, when known. */
  error?: StepError;
}

/**
 * Marks a method on a `@Workflow` class as that workflow's **inline dead-letter handler**. When a
 * run of the workflow is moved to `dead` (exceeded `maxRecoveryAttempts`), this method runs — as a
 * durable workflow itself, auto-registered as `<workflow>.dlq` with a `dlq:<runId>` id — receiving a
 * {@link DeadLetter} payload. It shares the class's injected dependencies, so the handler lives in
 * the same file as the workflow it protects.
 *
 * Takes precedence over `@Workflow({ deadLetterWorkflow })` and the module-level `deadLetterWorkflow`
 * default. The method signature is `(ctx, dead)` — the same `ctx` a workflow `run` gets.
 */
export function DeadLetter(): MethodDecorator {
  return (_target, _propertyKey, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(DEAD_LETTER_METADATA, true, descriptor.value as object);
    return descriptor;
  };
}

// biome-ignore lint/complexity/noBannedTypes: reflect-metadata reads from the method function
export function isDeadLetterHandler(method: Function): boolean {
  return Reflect.getMetadata(DEAD_LETTER_METADATA, method) === true;
}

export const ON_ERROR_METADATA = Symbol('nestjs-durable:on-error');

/**
 * An error class that declares the `code` it is thrown with (`static readonly code = 'invalid_line'`).
 * `@OnError(Class)` matches on that code, not on `instanceof`: a dispatched step's error reaches the
 * workflow as a plain `{ message, code }`, without its class.
 */
export interface ErrorClassWithCode {
  readonly code: string;
}

type WorkflowShape = { run(ctx: any, input: any): Promise<unknown> };

/**
 * An `@OnError` method: a workflow body that receives the failed run's {@link OnErrorInput}, typed with
 * `run`'s input, and returns what `run` returns.
 */
export type OnErrorMethod<T extends WorkflowShape> = (
  ctx: WorkflowCtx<any>,
  failure: OnErrorInput<Parameters<T['run']>[1]>,
) => Promise<Awaited<ReturnType<T['run']>>>;

/**
 * Marks a method on a `@Workflow` class as the handler for a failure of that workflow's runs. When a
 * run ends `failed` with an error of the given `code` (a string, or an {@link ErrorClassWithCode}),
 * the engine starts the method as its own durable workflow — registered as
 * `<workflow>.onError.<method>`, with a `<runId>.onError` id — and the failed run waits for it, then
 * settles with its outcome: the method's return value as its output, or its error. Without an
 * argument it takes any failure no other code matches.
 *
 * The engine routes the failure, so this holds for whatever ran the body (inline, an in-app worker,
 * another runtime). The method's signature is checked against the workflow: `(ctx, failure)`, with
 * `failure.input` typed as `run`'s input and the return type as `run`'s. Stack the decorator to give
 * one method several codes. Saga compensations of the failed body run before the handoff;
 * cancellation and non-determinism are never routed.
 */
export function OnError(match?: string | ErrorClassWithCode) {
  const code = match === undefined || typeof match === 'string' ? match : match.code;
  if (match !== undefined && typeof code !== 'string') {
    throw new Error(
      '@OnError(ErrorClass): the class has no static `code`. Declare `static readonly code = "..."` on it, or pass the code string.',
    );
  }
  return <T extends WorkflowShape>(
    _target: T,
    _propertyKey: string | symbol,
    descriptor: { value?: OnErrorMethod<T> | undefined },
  ): void => {
    const method = descriptor.value as object;
    const codes: (string | undefined)[] = Reflect.getMetadata(ON_ERROR_METADATA, method) ?? [];
    Reflect.defineMetadata(ON_ERROR_METADATA, [...codes, code], method);
  };
}

/** The codes an `@OnError` method takes (`undefined` for the catch-all), or undefined if it has none. */
// biome-ignore lint/complexity/noBannedTypes: reflect-metadata reads from the method function
export function onErrorCodesOf(method: Function): (string | undefined)[] | undefined {
  return Reflect.getMetadata(ON_ERROR_METADATA, method);
}

export const ON_EVENT_METADATA = Symbol('nestjs-durable:on-event');

/**
 * Subscribe a `@Workflow` class to one or more events: when any of them is published via
 * `publishEvent(name, payload)`, a fresh run of the workflow starts with the payload as input.
 * Equivalent to `@Workflow({ onEvent })` — use whichever reads better; multiple
 * `@OnDurableEvent(...)` decorators and the option are all merged.
 *
 * Named "durable" on purpose: `@nestjs/event-emitter` exports an `@OnEvent` decorator, and in an
 * app using both libs an auto-import picking the wrong one fails silently in either direction.
 */
export function OnDurableEvent(...events: OnEventEntry[]): ClassDecorator {
  return (target) => addEventSubscriptions(target, events);
}

/**
 * Coalesce a subscriber's triggers by **debouncing**: start it once events have been quiet for
 * `windowMs`, with the last one. `key` splits that per key: it receives the subscriber's input (what
 * `input` builds), and each distinct key debounces on its own.
 */
export interface SubscriberDebounce<TRunInput> {
  windowMs: number | string;
  key?: ((input: TRunInput) => string) | undefined;
}

/**
 * Coalesce a subscriber's triggers by **batching**: start it with `{ events }` once `maxSize` arrive
 * or `windowMs` passes since the first. `key` batches each distinct key on its own.
 */
export interface SubscriberBatch<TRunInput> {
  maxSize: number;
  windowMs: number | string;
  key?: ((input: TRunInput) => string) | undefined;
}

/** Options for {@link OnWorkflowCompleted} / {@link OnWorkflowFailed}. */
export interface OnWorkflowSettledOptions<TEvent, TRunInput> {
  /** Start only for the settled runs this returns true for, e.g. by `input` or `searchAttributes`. */
  where?: ((event: TEvent) => boolean) | undefined;
  /**
   * The started run's input, built from the event. Without it the run receives the
   * {@link WorkflowLifecycleEvent} itself. Lets an existing workflow subscribe with its own input
   * shape, and keeps the settled run's whole input and output out of the new run's row.
   */
  input?: ((event: TEvent) => TRunInput) | undefined;
  /**
   * Debounce this workflow's triggers (see {@link SubscriberDebounce}). Sets the workflow's
   * `onEvent` coalescing, so it applies to every event it subscribes to; a different `debounce` or
   * `batch` already declared on it fails at registration. Not with `batch`.
   */
  debounce?: SubscriberDebounce<TRunInput> | undefined;
  /**
   * Batch this workflow's triggers (see {@link SubscriberBatch}); the run's input becomes
   * `{ events: TRunInput[] }`. Same scope and conflicts as `debounce`. Not with `debounce`.
   */
  batch?: SubscriberBatch<TRunInput> | undefined;
}

/** Options for {@link OnWorkflowFailed}: also which endings start the subscriber. */
export interface OnWorkflowFailedOptions<TEvent, TRunInput>
  extends OnWorkflowSettledOptions<TEvent, TRunInput> {
  /** The endings that start it. Defaults to all three: `failed`, `cancelled` and `dead`. */
  statuses?: Array<'failed' | 'cancelled' | 'dead'> | undefined;
}

/** `O` with a required `batch` (and no `debounce`): the overload whose subscriber takes `{ events }`. */
type Batched<O, TRunInput> = O & { batch: SubscriberBatch<TRunInput>; debounce?: undefined };
/** `O` without `batch`: the overload whose subscriber takes `TRunInput` itself. */
type Unbatched<O> = O & { batch?: undefined };

/**
 * A class decorator that only accepts a workflow whose `run(ctx, input)` takes `TRunInput`, so a
 * subscriber with the wrong input shape fails to compile instead of failing at runtime.
 */
export type SubscriberDecorator<TRunInput> = <
  T extends abstract new (
    ...args: never[]
  ) => { run: (ctx: never, input: TRunInput) => unknown },
>(
  target: T,
) => void;

/**
 * Start a fresh run of the decorated workflow whenever a run of `workflow` **completes**. The new
 * run's input is the {@link WorkflowLifecycleEvent} (run id, input, output, tags, search
 * attributes), or what `input` builds from it. The settling workflow does not know about its
 * subscribers. Exactly once per settled run: see `runCompletedEvent` in
 * `@dudousxd/nestjs-durable-core`.
 *
 * With a class ref, the decorated workflow's `run` input is type-checked against the event (or
 * against `input`'s return type, or `{ events }` of it with `batch`). Child runs publish too, so a
 * workflow that `etl` starts as a child also starts its subscribers.
 *
 * ```ts
 * @Workflow({ name: 'refresh-summaries' })
 * @OnWorkflowCompleted(IngestionWorkflow, {
 *   where: (e) => e.input.type === 'mvr',
 *   input: (e) => ({ baseId: e.input.baseId }),
 *   debounce: { windowMs: '30s', key: (input) => input.baseId },
 * })
 * class RefreshSummariesWorkflow {
 *   async run(ctx: WorkflowCtx, input: { baseId: string }) {}
 * }
 * ```
 */
export function OnWorkflowCompleted<C extends WorkflowClass, TRunInput = LifecycleEventOf<C>>(
  workflow: C,
  options: Batched<OnWorkflowSettledOptions<LifecycleEventOf<C>, TRunInput>, TRunInput>,
): SubscriberDecorator<{ events: TRunInput[] }>;
export function OnWorkflowCompleted<C extends WorkflowClass, TRunInput = LifecycleEventOf<C>>(
  workflow: C,
  options?: Unbatched<OnWorkflowSettledOptions<LifecycleEventOf<C>, TRunInput>>,
): SubscriberDecorator<TRunInput>;
export function OnWorkflowCompleted(
  workflow: string,
  options?: OnWorkflowSettledOptions<WorkflowLifecycleEvent, unknown>,
): ClassDecorator;
export function OnWorkflowCompleted(
  workflow: WorkflowRef,
  options?: OnWorkflowSettledOptions<WorkflowLifecycleEvent, unknown>,
): ClassDecorator {
  return onWorkflowSettled(runCompletedEvent(workflow), options?.where, options);
}

/**
 * Start a fresh run of the decorated workflow whenever a run of `workflow` ends **failed,
 * cancelled or dead** (narrow it with `statuses`). Same contract as {@link OnWorkflowCompleted};
 * the event carries `error` and `status` instead of `output`.
 */
export function OnWorkflowFailed<C extends WorkflowClass, TRunInput = LifecycleEventOf<C>>(
  workflow: C,
  options: Batched<OnWorkflowFailedOptions<LifecycleEventOf<C>, TRunInput>, TRunInput>,
): SubscriberDecorator<{ events: TRunInput[] }>;
export function OnWorkflowFailed<C extends WorkflowClass, TRunInput = LifecycleEventOf<C>>(
  workflow: C,
  options?: Unbatched<OnWorkflowFailedOptions<LifecycleEventOf<C>, TRunInput>>,
): SubscriberDecorator<TRunInput>;
export function OnWorkflowFailed(
  workflow: string,
  options?: OnWorkflowFailedOptions<WorkflowLifecycleEvent, unknown>,
): ClassDecorator;
export function OnWorkflowFailed(
  workflow: WorkflowRef,
  options?: OnWorkflowFailedOptions<WorkflowLifecycleEvent, unknown>,
): ClassDecorator {
  const statuses = options?.statuses;
  const where = options?.where;
  const accepts =
    statuses || where
      ? (event: WorkflowLifecycleEvent) =>
          (!statuses || (statuses as string[]).includes(event.status)) && (!where || where(event))
      : undefined;
  return onWorkflowSettled(runFailedEvent(workflow), accepts, options);
}

/** Metadata key for the `onEvent` coalescing `@OnWorkflowCompleted` / `@OnWorkflowFailed` declare. */
export const ON_EVENT_BATCH_METADATA = Symbol('nestjs-durable:on-event-batch');

function onWorkflowSettled(
  event: string,
  where: ((event: WorkflowLifecycleEvent) => boolean) | undefined,
  options: OnWorkflowSettledOptions<WorkflowLifecycleEvent, unknown> | undefined,
): ClassDecorator {
  const subscription = {
    event,
    where: where as ((payload: unknown) => boolean) | undefined,
    input: options?.input as ((payload: unknown) => unknown) | undefined,
  };
  const batch = subscriberEventBatch(event, options);
  return (target) => {
    addEventSubscriptions(target, [subscription]);
    if (!batch) return;
    const existing = Reflect.getMetadata(ON_EVENT_BATCH_METADATA, target) as
      | EventBatchConfig
      | undefined;
    if (existing && !sameEventBatch(existing, batch)) {
      throw new Error(
        `${(target as { name?: string }).name ?? 'workflow'}: two lifecycle subscriptions declare different debounce/batch settings; a workflow coalesces all its triggers one way`,
      );
    }
    Reflect.defineMetadata(ON_EVENT_BATCH_METADATA, batch, target);
  };
}

/** The workflow-level coalescing a lifecycle subscription's `debounce` / `batch` option maps to. */
function subscriberEventBatch(
  event: string,
  options: OnWorkflowSettledOptions<WorkflowLifecycleEvent, unknown> | undefined,
): EventBatchConfig | undefined {
  if (options?.debounce && options.batch) {
    throw new Error(`${event}: a subscription takes debounce or batch, not both`);
  }
  if (options?.debounce) {
    return {
      mode: 'debounce',
      windowMs: parseDuration(options.debounce.windowMs),
      ...(options.debounce.key ? { key: options.debounce.key } : {}),
    };
  }
  if (options?.batch) {
    return {
      mode: 'batch',
      maxSize: options.batch.maxSize,
      windowMs: parseDuration(options.batch.windowMs),
      ...(options.batch.key ? { key: options.batch.key } : {}),
    };
  }
  return undefined;
}

/**
 * Whether two coalescing settings are the same: mode, window, size and key. Keys compare by source
 * text (`key.toString()`), so the same arrow written on two decorators matches; keys written
 * differently do not, even when they compute the same thing.
 */
function sameEventBatch(a: EventBatchConfig, b: EventBatchConfig): boolean {
  return (
    a.mode === b.mode &&
    a.windowMs === b.windowMs &&
    a.key?.toString() === b.key?.toString() &&
    (a.mode !== 'batch' || b.mode !== 'batch' || a.maxSize === b.maxSize)
  );
}

/**
 * How a workflow coalesces its `onEvent` triggers: `@Workflow({ debounce | batch })`, or what its
 * `@OnWorkflowCompleted` / `@OnWorkflowFailed` declare. Throws when both are set and differ, so a
 * workflow never silently coalesces one way while its decorator says another.
 */
export function eventBatchOf(meta: WorkflowMeta, target: object): EventBatchConfig | undefined {
  const declared: EventBatchConfig | undefined = meta.debounce
    ? { mode: 'debounce', windowMs: parseDuration(meta.debounce) }
    : meta.batch
      ? {
          mode: 'batch',
          maxSize: meta.batch.maxSize,
          windowMs: parseDuration(meta.batch.within),
        }
      : undefined;
  const fromSubscription = Reflect.getMetadata(ON_EVENT_BATCH_METADATA, target) as
    | EventBatchConfig
    | undefined;
  if (declared && fromSubscription && !sameEventBatch(declared, fromSubscription)) {
    throw new Error(
      `workflow ${meta.name}: @Workflow declares ${declared.mode} but a lifecycle subscription declares a different ${fromSubscription.mode}; declare it in one place`,
    );
  }
  return fromSubscription ?? declared;
}

function addEventSubscriptions(target: object, entries: OnEventEntry[]): void {
  const existing =
    (Reflect.getMetadata(ON_EVENT_METADATA, target) as OnEventEntry[] | undefined) ?? [];
  Reflect.defineMetadata(ON_EVENT_METADATA, [...existing, ...entries], target);
}

/**
 * All events a workflow class subscribes to: `@Workflow({ onEvent })`, `@OnDurableEvent`,
 * `@OnWorkflowCompleted` and `@OnWorkflowFailed`. Repeated bare names collapse to one.
 */
export function getOnEvents(meta: WorkflowMeta, target: object): OnEventEntry[] {
  const fromDecorator =
    (Reflect.getMetadata(ON_EVENT_METADATA, target) as OnEventEntry[] | undefined) ?? [];
  const names = new Set<string>();
  return [...(meta.onEvent ?? []), ...fromDecorator].filter((entry) => {
    if (typeof entry !== 'string') return true;
    if (names.has(entry)) return false;
    names.add(entry);
    return true;
  });
}
