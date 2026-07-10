import {
  DURABLE_STEP_CONFIG,
  DURABLE_STEP_NAME,
  type SearchAttributesSchema,
  type SingletonConfig,
  type StepConfig,
  type StepError,
  WORKFLOW_NAME_KEY,
  type WorkflowRef,
} from '@dudousxd/nestjs-durable-core';
import 'reflect-metadata';
import type { z } from 'zod';

export const WORKFLOW_METADATA = Symbol('nestjs-durable:workflow');

export interface WorkflowMeta {
  name: string;
  version: string;
  /** The workflow this workflow's dead runs route to (a name or a class). See `WorkflowOptions`. */
  deadLetterWorkflow?: WorkflowRef | undefined;
  /** Static searchable labels stamped on every run of this workflow. See `WorkflowOptions`. */
  tags?: string[] | undefined;
  /** Per-key serialization (a durable mutex). See `WorkflowOptions`. */
  singleton?: SingletonConfig | undefined;
  /** Max wall-clock lifetime before a run is cancelled (e.g. `'2h'`). See `WorkflowOptions`. */
  executionTimeout?: string | number | undefined;
  /** class-validator DTO validated at start. See `WorkflowOptions`. */
  inputSchema?: (new (...args: any[]) => object) | undefined;
  /** Custom input validator (throws on invalid). See `WorkflowOptions`. */
  validateInput?: ((input: unknown) => void | Promise<void>) | undefined;
  /** Typed/validated `searchAttributes` shape. See `WorkflowOptions`. */
  searchAttributes?: SearchAttributesSchema | undefined;
  /** Event names that start a fresh run of this workflow. See `WorkflowOptions`. */
  onEvent?: string[] | undefined;
  /** Debounce `onEvent` triggers — fire once it's quiet for this long. See `WorkflowOptions`. */
  debounce?: string | number | undefined;
  /** Batch `onEvent` triggers — fire on size or window. See `WorkflowOptions`. */
  batch?: { maxSize: number; within: string | number } | undefined;
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
   * Max wall-clock lifetime for a run of this workflow (e.g. `'2h'`, `'7 days'`, or ms). A run that
   * outlives it is moved to `cancelled` (`execution_timeout`) by the timer poller — a backstop for
   * runs that get stuck or loop forever. Omit for no limit.
   */
  executionTimeout?: string | number;
  /**
   * Validate the workflow input at `start` against a **class-validator DTO** (the same
   * `plainToInstance` + `validate` NestJS runs in controllers) — invalid input is rejected before any
   * run is created. Needs the optional peers `class-validator` + `class-transformer`.
   * `@Workflow({ inputSchema: CheckoutInput })`.
   */
  inputSchema?: new (
    ...args: any[]
  ) => object;
  /**
   * Custom input validator (throws on invalid) — an escape hatch for zod/yup/etc. instead of
   * `inputSchema`. Takes precedence over `inputSchema` if both are set.
   */
  validateInput?: (input: unknown) => void | Promise<void>;
  /**
   * Validate this workflow's {@link WorkflowCtx.upsertSearchAttributes} writes against a **Standard
   * Schema** (https://standardschema.dev — zod 3.24+, valibot, arktype, …). `ctx.upsertSearchAttributes`
   * validates the MERGED result (existing attributes shallow-merged with the patch) on every call —
   * an invalid merge throws, naming this workflow, the offending key(s), and the schema's issues. The
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
   * the `@OnDurableEvent(...)` class decorator; the two are merged.
   */
  onEvent?: string[];
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
  return (target) => {
    const meta: WorkflowMeta = {
      name: options.name,
      version: options.version ?? '1',
      deadLetterWorkflow: options.deadLetterWorkflow,
      tags: options.tags,
      singleton: options.singleton,
      executionTimeout: options.executionTimeout,
      inputSchema: options.inputSchema,
      validateInput: options.validateInput,
      searchAttributes: options.searchAttributes,
      onEvent: options.onEvent,
      debounce: options.debounce,
      batch: options.batch,
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
  input?: z.ZodType | undefined;
  /** Opt-in runtime output schema, validated before the handler's result is handed back. */
  output?: z.ZodType | undefined;
}

/**
 * `@Step({ name?, input?, output?, retries?, backoff?, backoffMs?, backoffMaxMs?, jitter?,
 * timeoutMs? })` — the object call form. See {@link Step}.
 */
export interface StepOptions {
  /** Explicit routing name, overriding the derived `Class.method`. */
  name?: string;
  /** Runtime input schema, validated at the serve boundary (opt-in — a bare `@Step()` skips it). */
  input?: z.ZodType;
  /** Runtime output schema, validated before the result is returned (opt-in). */
  output?: z.ZodType;
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
 *   timeoutMs? })` — optional name override, opt-in RUNTIME zod schemas, and a def-level
 *   durable-retry/liveness-timeout policy. `input` validates before the method runs; `output`
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

/**
 * @deprecated Use `@Step` instead. `@DurableStep` is a back-compat alias of {@link Step} and
 * writes the same `DURABLE_STEP_METADATA`, so discovery/registrars treat them identically.
 */
export const DurableStep = Step;

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
export function OnDurableEvent(...events: string[]): ClassDecorator {
  return (target) => {
    const existing = (Reflect.getMetadata(ON_EVENT_METADATA, target) as string[] | undefined) ?? [];
    Reflect.defineMetadata(ON_EVENT_METADATA, [...existing, ...events], target);
  };
}

/** @deprecated Renamed to `OnDurableEvent` — this alias clashes with `@nestjs/event-emitter`'s `@OnEvent` and will be removed in the next minor. */
export const OnEvent = OnDurableEvent;

/** All events a workflow class subscribes to — the union of `@Workflow({ onEvent })` and `@OnDurableEvent`. */
export function getOnEvents(meta: WorkflowMeta, target: object): string[] {
  const fromDecorator =
    (Reflect.getMetadata(ON_EVENT_METADATA, target) as string[] | undefined) ?? [];
  return [...new Set([...(meta.onEvent ?? []), ...fromDecorator])];
}
