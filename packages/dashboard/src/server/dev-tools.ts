import type {
  GroupHealth,
  RunFacetQuery,
  RunListItem,
  RunQuery,
  RunResult,
  RunStatus,
  RunValueAxis,
} from '@dudousxd/nestjs-durable-core';
import {
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { parseAttrFilters } from './attr-filter.js';
import { CONSOLE_AUTHORIZE_DECIDE, type ConsoleDecide } from './console-authorize.js';
import { DashboardService } from './dashboard.service.js';
import { toRunListRow } from './run-list-row.js';
import { DASHBOARD_DEV_TOOLS } from './tokens.js';

// ── the dev-tools contract (v1), re-declared: this package never imports the agent's MCP server ──

/** The process-wide slot `@dudousxd/nestjs-agent-mcp-server` serves on its dev MCP endpoint. */
export const DEV_TOOLS_SLOT: symbol = Symbol.for('@dudousxd/aviary:dev-tools');

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  /** Arrays hold strings only. */
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** An object of scalar / enum / array-of-string properties. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

/** What the slot's `authorize` answers: the console's resolved decision. */
export type DevToolsDecision =
  | { allowed: true; caller?: string }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  context: ExecutionContext;
  caller: { id: string; via: 'token' | 'session' | 'open' };
  limits: { maxRows: number; maxBytes: number };
}

/** One developer tool, as the dev-tools slot takes it. */
export interface DurableDevTool {
  /** `durable_<verb>_<noun>`. */
  name: string;
  /** `read` tools are listed by default; `action` tools only when the app opts in. */
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  /** Set on actions that cancel. */
  destructive?: boolean;
  /** Capability, not access: hides a tool this deployment cannot run. */
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call?: DevToolCall): Promise<unknown>;
}

interface DevToolsLib {
  lib: string;
  title: string;
  authorize(context: ExecutionContext): Promise<DevToolsDecision>;
  tools: DurableDevTool[];
}

interface DevToolsSlot {
  readonly version: 1;
  readonly libs: DevToolsLib[];
  register(lib: DevToolsLib): () => void;
}

/** The slot, created when absent (whoever loads first creates it). */
function devToolsSlot(): Partial<DevToolsSlot> {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[DEV_TOOLS_SLOT] as Partial<DevToolsSlot> | undefined;
  if (existing !== undefined) return existing;
  const libs: DevToolsLib[] = [];
  const slot: DevToolsSlot = {
    version: 1,
    libs,
    register(lib) {
      if (libs.some((entry) => entry.lib === lib.lib)) {
        throw new Error(`dev tools: the lib "${lib.lib}" is already registered`);
      }
      libs.push(lib);
      return () => {
        const index = libs.indexOf(lib);
        if (index !== -1) libs.splice(index, 1);
      };
    },
  };
  holder[DEV_TOOLS_SLOT] = slot;
  return slot;
}

// ── the durable tools ────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Runs `durable_retry_run` / `durable_cancel_run` act on at most per call. */
export const MAX_RUN_IDS = 100;
/** A failed run's error message is cut to this many characters in a list. */
const ERROR_SUMMARY_CHARS = 300;

const RUN_STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'suspended',
  'completed',
  'failed',
  'cancelling',
  'cancelled',
  'dead',
  'blocked',
] as const satisfies readonly RunStatus[];

const COUNT_FIELDS = [
  'status',
  'workflow',
  'origin',
  'namespace',
  'tag',
  'attributeKey',
  'attributeValue',
] as const;

const limit: DevToolInputProperty = {
  type: 'integer',
  description: `Rows per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
  minimum: 1,
  maximum: MAX_LIMIT,
};
const cursor: DevToolInputProperty = {
  type: 'string',
  description: 'Pass the `next` of the previous page.',
};
const runId: DevToolInputProperty = { type: 'string', description: 'Run id.' };
const runIds: DevToolInputProperty = {
  type: 'array',
  items: { type: 'string' },
  description: `Several run ids (1 to ${MAX_RUN_IDS}), instead of \`id\`.`,
};
const scheduleKey: DevToolInputProperty = { type: 'string', description: 'Schedule id.' };

/** The run filters every run tool shares, as the console's run list reads them. */
const runFilters: Record<string, DevToolInputProperty> = {
  workflow: { type: 'string', description: 'Workflow name.' },
  tag: { type: 'string', description: 'A tag the run carries.' },
  namespace: { type: 'string', description: 'Worker pool (namespace).' },
  attr: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Search-attribute predicates `key:op:value` (ops: eq, ne, gt, gte, lt, lte, in with `|`), ANDed.',
  },
};

const str = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

function limitOf(input: Record<string, unknown>): number {
  const value = input.limit;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, MAX_LIMIT)
    : DEFAULT_LIMIT;
}

/** The offset a `cursor` carries (`0` without one). A cursor this tool never issued is an error. */
function offsetOf(input: Record<string, unknown>): number {
  const value = str(input.cursor);
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error(`"cursor" must be the \`next\` of a previous page, got "${value}"`);
  }
  return Number(value);
}

function required(input: Record<string, unknown>, key: string): string {
  const value = str(input[key]);
  if (value === undefined) throw new Error(`"${key}" is required`);
  return value;
}

/** One page out of `limit + 1` fetched rows: the extra row only proves there is a next page. */
function page<T>(rows: T[], offset: number, size: number): { items: T[]; next: string | null } {
  return {
    items: rows.slice(0, size),
    next: rows.length > size ? String(offset + size) : null,
  };
}

/** The run predicates of `input` (no status, no paging): what the console's filter builds. */
function runPredicates(input: Record<string, unknown>): RunFacetQuery {
  const query: RunFacetQuery = {};
  const workflow = str(input.workflow);
  if (workflow !== undefined) query.workflow = workflow;
  const tag = str(input.tag);
  if (tag !== undefined) query.tag = tag;
  const namespace = str(input.namespace);
  if (namespace !== undefined) query.namespace = namespace;
  const attr = Array.isArray(input.attr)
    ? input.attr.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
  if (attr.length > 0) {
    const attributes = parseAttrFilters(attr);
    if (attributes === undefined || attributes.length !== attr.length) {
      throw new Error(`"attr" entries must read \`key:op:value\`, got ${JSON.stringify(attr)}`);
    }
    query.attributes = attributes;
  }
  return query;
}

function statusOf(input: Record<string, unknown>): RunStatus | undefined {
  const status = str(input.status);
  if (status === undefined) return undefined;
  if (!RUN_STATUSES.includes(status as RunStatus)) {
    throw new Error(`"status" must be one of ${RUN_STATUSES.join(', ')}, got "${status}"`);
  }
  return status as RunStatus;
}

/** A list row: the console's run row plus a one-line summary of its error. */
function listRow(run: RunListItem) {
  const row: Record<string, unknown> = { ...toRunListRow(run) };
  const message = run.error?.message;
  if (typeof message === 'string' && message !== '') {
    const line = message.split('\n', 1)[0] ?? '';
    row.error = line.length > ERROR_SUMMARY_CHARS ? `${line.slice(0, ERROR_SUMMARY_CHARS)}…` : line;
  }
  return row;
}

/**
 * Runs a console call, turning its HTTP errors into plain errors (the endpoint answers a throw as an
 * MCP `isError` result): a 404 reads `<what> not found`, any other HTTP error keeps its message.
 * Core's `ScheduleNotFoundError` reads as not found too.
 */
async function call<T>(what: () => string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof NotFoundException ||
      (error instanceof Error && error.name === 'ScheduleNotFoundError')
    ) {
      throw new Error(`${what()} not found`);
    }
    if (error instanceof HttpException) throw new Error(error.message);
    throw error;
  }
}

/** `null` from the service means the run is unknown (or hidden by tenancy): not found. */
function found<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} not found`);
  return value;
}

/** The ids an action applies to: `id` or `ids` (1 to {@link MAX_RUN_IDS}). */
function idsOf(input: Record<string, unknown>): { ids: string[]; many: boolean } {
  const one = str(input.id);
  const many = Array.isArray(input.ids)
    ? input.ids.filter((id): id is string => typeof id === 'string' && id !== '')
    : undefined;
  if (one !== undefined && many !== undefined) throw new Error('pass "id" or "ids", not both');
  if (one !== undefined) return { ids: [one], many: false };
  if (many === undefined || many.length === 0) throw new Error('"id" or "ids" is required');
  if (many.length > MAX_RUN_IDS) {
    throw new Error(`"ids" lists ${many.length} runs; at most ${MAX_RUN_IDS} per call`);
  }
  return { ids: many, many: true };
}

/**
 * Applies `act` to each run in order. One `id`: the result, or the error. Several `ids`: stops at
 * the first that fails and returns `{ applied, failed: { id, error }, skipped }`, so what changed is
 * never in doubt.
 */
async function each(
  input: Record<string, unknown>,
  act: (id: string) => Promise<RunResult>,
): Promise<unknown> {
  const { ids, many } = idsOf(input);
  if (!many) return act(ids[0] as string);
  const applied: RunResult[] = [];
  for (const [index, id] of ids.entries()) {
    try {
      applied.push(await act(id));
    } catch (error) {
      return {
        applied,
        failed: { id, error: error instanceof Error ? error.message : String(error) },
        skipped: ids.slice(index + 1),
      };
    }
  }
  return { applied };
}

/** Backlog groups nobody consumes, deepest first: the alert the console's Workers panel shows. */
function starvedGroups(groups: GroupHealth[]) {
  return groups
    .filter((group) => group.depth > 0 && group.liveWorkers.length === 0)
    .sort((a, b) => b.depth - a.depth)
    .map(({ group, depth, kind }) => ({ group, depth, ...(kind ? { kind } : {}) }));
}

/**
 * The durable developer tools (lib `durable`): the console's reads and its run and schedule
 * actions, through the same {@link DashboardService} methods its API serves, so tenancy and the
 * app's redaction apply. Signals, run events and schedules are available only on the control plane.
 */
export function durableDevTools(service: DashboardService): DurableDevTool[] {
  const controlPlane = () => service.capabilities().controlPlane;
  const schedules = () => service.capabilities().schedules;
  return [
    {
      name: 'durable_list_runs',
      kind: 'read',
      description:
        'Workflow runs, newest first: id, workflow, status, what a suspended run waits on, times, tags and a one-line error summary (no input or output). Filters: status, workflow, tag, namespace, origin, attr. Returns { items, next }; pass next as cursor.',
      input: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: RUN_STATUSES, description: 'Run status.' },
          ...runFilters,
          origin: { type: 'string', description: 'The package the run came from.' },
          cursor,
          limit,
        },
      },
      async run(input) {
        const size = limitOf(input);
        const offset = offsetOf(input);
        const status = statusOf(input);
        const origin = str(input.origin);
        const query: RunQuery = {
          ...runPredicates(input),
          ...(status !== undefined ? { status } : {}),
          ...(origin !== undefined ? { origin } : {}),
          offset,
          limit: size + 1,
        };
        const runs = await call(
          () => 'runs',
          () => service.listRuns(query),
        );
        return page(runs.map(listRow), offset, size);
      },
    },
    {
      name: 'durable_get_run',
      kind: 'read',
      description:
        'One run: its input, output, error, step timeline, children, fans (summarized over 50 members unless full) and lifecycle links. `field` returns that one field only (e.g. "steps"). An error when no run has that id.',
      input: {
        type: 'object',
        properties: {
          id: runId,
          full: { type: 'boolean', description: 'Every fan member inline (default false).' },
          field: { type: 'string', description: 'Return only this top-level field.' },
        },
        required: ['id'],
      },
      async run(input) {
        const id = required(input, 'id');
        const detail = found(
          await call(
            () => `run ${id}`,
            () =>
              service.getRunDetail(id, input.full === true ? undefined : { summarizeFansOver: 50 }),
          ),
          `run ${id}`,
        );
        const { etag: _etag, notModified: _notModified, ...body } = detail;
        const field = str(input.field);
        if (field === undefined) return body;
        if (!Object.hasOwn(body, field)) {
          throw new Error(
            `run ${id} has no field "${field}"; fields: ${Object.keys(body).join(', ')}`,
          );
        }
        return { id, [field]: (body as Record<string, unknown>)[field] };
      },
    },
    {
      name: 'durable_list_fan_members',
      kind: 'read',
      description:
        "One fan's members (the steps or children of a fan-out group), in order. Filters: failed (only failed members). Returns { items, total, next }; pass next as cursor. An error when the run or the fan does not exist.",
      input: {
        type: 'object',
        properties: {
          id: runId,
          group: { type: 'string', description: 'The fan group, as the run detail names it.' },
          failed: { type: 'boolean', description: 'Only failed members.' },
          cursor,
          limit,
        },
        required: ['id', 'group'],
      },
      async run(input) {
        const id = required(input, 'id');
        const group = required(input, 'group');
        const size = limitOf(input);
        const offset = offsetOf(input);
        const fan = found(
          await call(
            () => `fan ${group} of run ${id}`,
            () =>
              service.getFanMembers(id, group, {
                offset,
                limit: size,
                failedOnly: input.failed === true,
              }),
          ),
          `fan ${group} of run ${id}`,
        );
        const end = offset + fan.items.length;
        return {
          items: fan.items,
          total: fan.total,
          next: fan.items.length > 0 && end < fan.total ? String(end) : null,
        };
      },
    },
    {
      name: 'durable_count_runs_by',
      kind: 'read',
      description:
        'How many runs have each value of one field (status, workflow, origin, namespace, tag, attributeKey, or attributeValue with key), most frequent first. Filters: workflow, tag, namespace, attr. Returns { items: [{ value, count }], next }; pass next as cursor. Empty when the store cannot count that field.',
      input: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: COUNT_FIELDS, description: 'The field to count by.' },
          key: { type: 'string', description: 'The search attribute, for attributeValue.' },
          ...runFilters,
          cursor,
          limit,
        },
        required: ['field'],
      },
      async run(input) {
        const field = required(input, 'field');
        if (!(COUNT_FIELDS as readonly string[]).includes(field)) {
          throw new Error(`"field" must be one of ${COUNT_FIELDS.join(', ')}, got "${field}"`);
        }
        const size = limitOf(input);
        const offset = offsetOf(input);
        const predicates = runPredicates(input);
        if (field === 'status' || field === 'origin') {
          // The console's chips: (status, origin) counts in one query, summed per value here.
          const rows = await call(
            () => 'runs',
            () => service.runFacets(predicates),
          );
          const counts = new Map<string | null, number>();
          for (const row of rows) {
            const value = field === 'status' ? row.status : row.origin;
            counts.set(value, (counts.get(value) ?? 0) + row.count);
          }
          const items = [...counts]
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
          return page(items.slice(offset), offset, size);
        }
        const axis: RunValueAxis =
          field === 'attributeValue'
            ? { field, key: required(input, 'key') }
            : { field: field as Exclude<RunValueAxis['field'], 'attributeValue'> };
        const rows = await call(
          () => 'runs',
          () => service.runValueFacets(axis, predicates, { offset, limit: size + 1 }),
        );
        return page(rows, offset, size);
      },
    },
    {
      name: 'durable_get_health',
      kind: 'read',
      description:
        "The fleet at a glance: run counts by status (pending backlog, dead, blocked: a run no compatible worker can take), queues with backlog and no live worker (starved), live worker count, and this deployment's role (control plane or tenant).",
      input: { type: 'object', properties: {} },
      async run() {
        const [facets, groups] = await Promise.all([
          call(
            () => 'runs',
            () => service.runFacets({}),
          ),
          call(
            () => 'workers',
            () => service.workerHealth(),
          ),
        ]);
        const runs: Record<string, number> = {};
        for (const row of facets) runs[row.status] = (runs[row.status] ?? 0) + row.count;
        const workers = new Set<string>();
        for (const group of groups) {
          for (const worker of group.liveWorkers) workers.add(worker.instanceId);
        }
        const starved = starvedGroups(groups);
        return {
          topology: service.topology(),
          runs,
          backlog: runs.pending ?? 0,
          dead: runs.dead ?? 0,
          blocked: runs.blocked ?? 0,
          queues: groups.length,
          liveWorkers: workers.size,
          starved,
          healthy: starved.length === 0 && (runs.blocked ?? 0) === 0,
        };
      },
    },
    {
      name: 'durable_list_workers',
      kind: 'read',
      description:
        'Worker groups (queues): group, kind (workflow or step), queue depth and the live workers with their heartbeats. A group with depth > 0 and no live worker is starved. Returns { items, next: null }.',
      input: { type: 'object', properties: {} },
      async run() {
        const groups = await call(
          () => 'workers',
          () => service.workerHealth(),
        );
        return { items: groups, next: null };
      },
    },
    {
      name: 'durable_list_schedules',
      kind: 'read',
      description:
        'Persisted schedules, soonest due first: id, workflow, cadence (cron, every or rrule), paused, nextFireAt, lastFireAt, lastRunId, fires, lastError. Filters: workflow, tag, namespace, paused. Returns { items, next }; pass next as cursor.',
      input: {
        type: 'object',
        properties: {
          workflow: { type: 'string', description: 'Workflow name.' },
          tag: { type: 'string', description: 'A tag the schedule carries.' },
          namespace: { type: 'string', description: 'Worker pool (namespace).' },
          paused: { type: 'boolean', description: 'Only paused (true) or active (false).' },
          cursor,
          limit,
        },
      },
      available: schedules,
      async run(input) {
        const size = limitOf(input);
        const offset = offsetOf(input);
        const workflow = str(input.workflow);
        const tag = str(input.tag);
        const namespace = str(input.namespace);
        const rows = await call(
          () => 'schedules',
          () =>
            service.listSchedules({
              ...(workflow !== undefined ? { workflow } : {}),
              ...(tag !== undefined ? { tag } : {}),
              ...(namespace !== undefined ? { namespace } : {}),
              ...(typeof input.paused === 'boolean' ? { paused: input.paused } : {}),
              offset,
              limit: size + 1,
            }),
        );
        return page(rows, offset, size);
      },
    },
    {
      name: 'durable_get_run_event',
      kind: 'read',
      description:
        'The latest value a run published for `key` with ctx.setEvent (a live query, no side effect). Returns { id, key, value }; value is null when the run never published that key. An error when no run has that id.',
      input: {
        type: 'object',
        properties: { id: runId, key: { type: 'string', description: 'Event key.' } },
        required: ['id', 'key'],
      },
      available: controlPlane,
      async run(input) {
        const id = required(input, 'id');
        const key = required(input, 'key');
        if (
          !(await call(
            () => `run ${id}`,
            () => service.runExists(id),
          ))
        ) {
          throw new Error(`run ${id} not found`);
        }
        const value = await call(
          () => `run ${id}`,
          () => service.getEvent(id, key),
        );
        return { id, key, value: value ?? null };
      },
    },
    {
      name: 'durable_retry_run',
      kind: 'action',
      description: `Re-runs a failed, dead or cancelled run; completed steps replay from their checkpoints. Returns { runId, status }. With ids (at most ${MAX_RUN_IDS}), runs them in order and stops at the first that fails: { applied, failed: { id, error }, skipped }. An error when no run has that id.`,
      input: { type: 'object', properties: { id: runId, ids: runIds } },
      async run(input) {
        return each(input, async (id) =>
          found(
            await call(
              () => `run ${id}`,
              () => service.retry(id),
            ),
            `run ${id}`,
          ),
        );
      },
    },
    {
      name: 'durable_cancel_run',
      kind: 'action',
      destructive: true,
      description: `Cancels a run that has not finished (with compensate: true, its completed steps' compensations run first). Returns { runId, status }. With ids (at most ${MAX_RUN_IDS}), cancels them in order and stops at the first that fails: { applied, failed: { id, error }, skipped }. An error when no run has that id.`,
      input: {
        type: 'object',
        properties: {
          id: runId,
          ids: runIds,
          compensate: { type: 'boolean', description: 'Run compensations (default false).' },
        },
      },
      async run(input) {
        const compensate = input.compensate === true;
        return each(input, async (id) =>
          found(
            await call(
              () => `run ${id}`,
              () => service.cancel(id, { compensate }),
            ),
            `run ${id}`,
          ),
        );
      },
    },
    {
      name: 'durable_continue_run',
      kind: 'action',
      description:
        'Resumes a run paused at a ctx.breakpoint. Returns { runId, status }. An error when no run has that id, or when it is not paused at a breakpoint.',
      input: { type: 'object', properties: { id: runId }, required: ['id'] },
      async run(input) {
        const id = required(input, 'id');
        const what = () => `run ${id}`;
        const result = await call(what, () => service.continue(id));
        if (result) return result;
        if (!(await call(what, () => service.runExists(id))))
          throw new Error(`run ${id} not found`);
        throw new Error(`run ${id} is not paused at a breakpoint`);
      },
    },
    {
      name: 'durable_signal_run',
      kind: 'action',
      description:
        'Sends a signal: delivers payload (JSON text; omitted is null) to the run waiting on token (ctx.waitForSignal or a ctx.webhook token). Returns { delivered: true, runId, status }, or { delivered: false } when no run you can see waits on the token yet: the engine then buffers the payload for the next run that waits on it.',
      input: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'The signal token the run waits on.' },
          payload: { type: 'string', description: 'The payload, as JSON text.' },
        },
        required: ['token'],
      },
      available: controlPlane,
      async run(input) {
        const token = required(input, 'token');
        let payload: unknown = null;
        if (typeof input.payload === 'string' && input.payload.trim() !== '') {
          try {
            payload = JSON.parse(input.payload);
          } catch {
            throw new Error('"payload" must be JSON text (quote a plain string: "\\"ok\\"")');
          }
        }
        const result = await call(
          () => `token ${token}`,
          () => service.signal(token, payload),
        );
        return result
          ? { delivered: true, runId: result.runId, status: result.status }
          : { delivered: false };
      },
    },
    {
      name: 'durable_trigger_schedule',
      kind: 'action',
      description:
        'Starts one run of a schedule now, outside its cadence (it does not count as a fire). Returns { runId, status }. An error when no schedule has that id.',
      input: { type: 'object', properties: { key: scheduleKey }, required: ['key'] },
      available: schedules,
      async run(input) {
        const key = required(input, 'key');
        return call(
          () => `schedule ${key}`,
          () => service.triggerSchedule(key),
        );
      },
    },
    {
      name: 'durable_pause_schedule',
      kind: 'action',
      description:
        'Pauses a schedule (paused: true, the default) or resumes it from its next window (paused: false). Returns the schedule. An error when no schedule has that id.',
      input: {
        type: 'object',
        properties: {
          key: scheduleKey,
          paused: { type: 'boolean', description: 'false resumes it (default true).' },
        },
        required: ['key'],
      },
      available: schedules,
      async run(input) {
        const key = required(input, 'key');
        return call(
          () => `schedule ${key}`,
          () => (input.paused === false ? service.resumeSchedule(key) : service.pauseSchedule(key)),
        );
      },
    },
  ];
}

const logger = new Logger('DurableDashboardModule');

/**
 * Registers the durable tools into the dev-tools slot, gated by the console's own resolved
 * `authorize`, when the console is mounted (or `devTools: true`). Removed again on shutdown.
 */
@Injectable()
export class DurableDevToolsRegistration implements OnModuleInit, OnModuleDestroy {
  #unregister: (() => void) | undefined;

  constructor(
    @Inject(DASHBOARD_DEV_TOOLS) private readonly enabled: boolean,
    @Inject(DashboardService) private readonly service: DashboardService,
    @Inject(CONSOLE_AUTHORIZE_DECIDE) private readonly decide: ConsoleDecide,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) return;
    const slot = devToolsSlot();
    if (slot.version !== 1 || typeof slot.register !== 'function') return;
    try {
      this.#unregister = slot.register({
        lib: 'durable',
        title: 'Durable workflows',
        authorize: (context) => this.decide(context),
        tools: durableDevTools(this.service),
      });
    } catch (error) {
      // Another application in this process registered the durable tools: keep the console up.
      logger.warn(
        `durable dev tools not registered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.#unregister?.();
    this.#unregister = undefined;
  }
}
