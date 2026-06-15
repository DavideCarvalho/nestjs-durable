# Sub-process lifecycle (lib) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `@dudousxd/nestjs-durable` an extensible sub-process model — run identity + open phase/group labels alongside the closed `ok|failed|skipped` terminal status — and render each sub-process as an expandable lifecycle row in the dashboard.

**Architecture:** Additive, optional fields on `StepEvent` (`subId`, `group`, `phase`) + a new `subEvent()` method on `StepLogger` (the existing `sub()` stays as back-compat sugar, byte-identical output). The dashboard groups a step's events by run identity into sub-process records via a pure, unit-tested function, and `StepDetailPanel` renders them as accordions. Live phase events already flow through the existing `step.progress` SSE merge unchanged.

**Tech Stack:** TypeScript, pnpm + turbo monorepo, Vitest (`vitest run` from root, `*.spec.ts` co-located), React (dashboard SPA), Biome, changesets.

**Scope:** This plan covers the **lib only** (`packages/core`, `packages/dashboard`) — the releasable prerequisite. Flip consumer wiring (the Python emitter + the handler-as-step workflow restructuring in `flip-python-db` / `flip-nestjs`) is a **separate plan**, written after this releases.

**Spec:** `docs/plans/2026-06-15-extensible-subprocess-lifecycle.md`

**Commands:**
- Single test file: `pnpm exec vitest run <path-to-spec>`
- Typecheck a package: `pnpm --filter @dudousxd/nestjs-durable-core typecheck` (and `...-dashboard`)
- Lint/format: `pnpm lint` / `pnpm lint:fix`

---

### Task 1: Extend `StepEvent` and `StepLogger` (core types)

**Files:**
- Modify: `packages/core/src/interfaces.ts:102-117` (StepEvent), `:126-133` (StepLogger)

- [ ] **Step 1: Add the new optional fields to `StepEvent`**

In `packages/core/src/interfaces.ts`, replace the `StepEvent` interface body (keep the existing `at`/`level`/`message`/`name`/`status`/`process`/`data` and their comments) by inserting these fields after `message`:

```ts
export interface StepEvent {
  /** Epoch ms. */
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  /** Stable run identity for a sub-process. Distinct invocations of the same `name` carry distinct
   *  ids, so their phases and log trails never collapse into one. Omitted by the back-compat
   *  `sub()` path (which keys by `name`). */
  subId?: string;
  /** For a sub-step/sub-process within the step: its name. */
  name?: string;
  /** Open, consumer-defined grouping label for a sub-process (e.g. a handler/lane). The dashboard
   *  groups rows by it. The library never interprets it. */
  group?: string;
  /** For a sub-step: its terminal outcome (closed enum — drives colour + aggregation). */
  status?: 'ok' | 'failed' | 'skipped';
  /** Open, consumer-defined intermediate phase label for a sub-process transition. Carries no
   *  terminal `status`; the library timestamps and orders it but never interprets it. */
  phase?: string;
  /** For a log line emitted *inside* a sub-process: that owning sub-process's name, so the dashboard
   *  can group a step's log trail under each sub-process instead of one flat list. Set on logs (no
   *  `status`); a worker stamps it from the sub-process it's running.
   *  @deprecated Superseded by `subId` for run-distinct grouping; kept so existing workers/runs render. */
  process?: string;
  /** Optional structured payload. `data.durationMs` (number) overrides the derived duration. */
  data?: unknown;
}
```

- [ ] **Step 2: Add `subEvent` to the `StepLogger` interface**

In the same file, add to the `StepLogger` interface (after the existing `sub` method):

```ts
  /** Record a sub-process event. Pass `phase` for an intermediate transition (no terminal status);
   *  pass `status` for the terminal outcome. `id` is the run identity (distinct per invocation);
   *  `group` is an open grouping label. The cross-language counterpart is the Python SDK's
   *  `StepContext`. */
  subEvent(e: {
    id: string;
    name: string;
    group?: string;
    phase?: string;
    status?: 'ok' | 'failed' | 'skipped';
    message?: string;
    data?: unknown;
  }): void;
```

- [ ] **Step 3: Typecheck core (expected to FAIL — `createStepLogger` doesn't implement `subEvent` yet)**

Run: `pnpm --filter @dudousxd/nestjs-durable-core typecheck`
Expected: FAIL — `createStepLogger` return value missing property `subEvent`.

- [ ] **Step 4: Commit the types**

```bash
git add packages/core/src/interfaces.ts
git commit -m "feat(core): add subId/group/phase to StepEvent + subEvent to StepLogger"
```

---

### Task 2: Implement `subEvent` in `createStepLogger` (core)

**Files:**
- Modify: `packages/core/src/step-logger.ts`
- Test: `packages/core/src/step-logger.spec.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/step-logger.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { StepEvent } from './interfaces';
import { createStepLogger } from './step-logger';

const at = () => 1000;

describe('createStepLogger', () => {
  it('sub() keeps its existing shape (no subId — back-compat)', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).sub('ProcessKpi', 'ok');
    expect(events).toEqual([
      { at: 1000, level: 'info', message: 'ProcessKpi', name: 'ProcessKpi', status: 'ok' },
    ]);
  });

  it('subEvent() records an intermediate phase (no status)', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).subEvent({
      id: 'r1',
      name: 'ProcessKpi',
      group: 'af_fleet',
      phase: 'processing',
    });
    expect(events).toEqual([
      {
        at: 1000,
        level: 'info',
        message: 'processing',
        subId: 'r1',
        name: 'ProcessKpi',
        group: 'af_fleet',
        phase: 'processing',
      },
    ]);
  });

  it('subEvent() records a terminal outcome, mapping failed → error level and keeping data', () => {
    const events: StepEvent[] = [];
    createStepLogger(events, at).subEvent({
      id: 'r1',
      name: 'ProcessKpi',
      status: 'failed',
      data: { durationMs: 42 },
    });
    expect(events).toEqual([
      {
        at: 1000,
        level: 'error',
        message: 'ProcessKpi',
        subId: 'r1',
        name: 'ProcessKpi',
        status: 'failed',
        data: { durationMs: 42 },
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/core/src/step-logger.spec.ts`
Expected: FAIL — `subEvent is not a function` (the two `subEvent` cases; the `sub()` case passes).

- [ ] **Step 3: Implement `subEvent`**

In `packages/core/src/step-logger.ts`, add `subEvent` to the returned object (after `sub`). Leave `sub` exactly as it is:

```ts
    subEvent: (e) =>
      events.push({
        at: now(),
        level: e.status === 'failed' ? 'error' : e.status === 'skipped' ? 'warn' : 'info',
        message: e.message ?? e.phase ?? e.name,
        subId: e.id,
        name: e.name,
        ...(e.group === undefined ? {} : { group: e.group }),
        ...(e.phase === undefined ? {} : { phase: e.phase }),
        ...(e.status === undefined ? {} : { status: e.status }),
        ...(e.data === undefined ? {} : { data: e.data }),
      }),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/core/src/step-logger.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck core (now passes)**

Run: `pnpm --filter @dudousxd/nestjs-durable-core typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/step-logger.ts packages/core/src/step-logger.spec.ts
git commit -m "feat(core): implement StepLogger.subEvent (phase + terminal)"
```

---

### Task 3: Mirror the new fields in the dashboard's `StepEvent` (client types)

The dashboard keeps its **own** copy of `StepEvent` (the serialized client shape) in
`packages/dashboard/src/client/durable-client.ts` — it must stay in sync with core.

**Files:**
- Modify: `packages/dashboard/src/client/durable-client.ts:27-38`

- [ ] **Step 1: Add the fields to the dashboard `StepEvent`**

Replace the `StepEvent` interface in `durable-client.ts` with (mirrors core exactly):

```ts
export interface StepEvent {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  /** Stable run identity for a sub-process; distinct invocations of the same `name` get distinct ids. */
  subId?: string;
  /** For a sub-step/sub-process within the step: its name. */
  name?: string;
  /** Open, consumer-defined grouping label for a sub-process (e.g. a handler/lane). */
  group?: string;
  /** For a sub-step: its terminal outcome. */
  status?: 'ok' | 'failed' | 'skipped';
  /** Open, consumer-defined intermediate phase label for a sub-process transition (no `status`). */
  phase?: string;
  /** @deprecated owning sub-process **name** for a log line — superseded by `subId`. */
  process?: string;
  data?: unknown;
}
```

- [ ] **Step 2: Typecheck the dashboard**

Run: `pnpm --filter @dudousxd/nestjs-durable-dashboard typecheck`
Expected: PASS (additive optional fields break nothing).

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/client/durable-client.ts
git commit -m "feat(dashboard): mirror subId/group/phase on client StepEvent"
```

---

### Task 4: Pure `groupSubProcesses` function (dashboard)

Group a step's events into sub-process records by run identity. Pure + unit-tested (mirrors the
repo's `run-display-status.spec.ts` convention — pure logic is tested, React is not).

**Files:**
- Create: `packages/dashboard/src/client/group-subprocesses.ts`
- Test: `packages/dashboard/src/client/group-subprocesses.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/dashboard/src/client/group-subprocesses.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { StepEvent } from './durable-client';
import { groupSubProcesses } from './group-subprocesses';

function ev(over: Partial<StepEvent> = {}): StepEvent {
  return { at: 0, level: 'info', message: '', ...over };
}

describe('groupSubProcesses', () => {
  it('back-compat: a terminal-only event (sub) becomes one sub with no phases', () => {
    const { subs, stepLogs } = groupSubProcesses([
      ev({ at: 5, name: 'ProcessKpi', status: 'ok', message: 'ProcessKpi' }),
    ]);
    expect(stepLogs).toEqual([]);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ id: 'ProcessKpi', name: 'ProcessKpi', status: 'ok' });
    expect(subs[0].phases).toEqual([]);
  });

  it('distinct subIds with the same name do NOT collapse', () => {
    const { subs } = groupSubProcesses([
      ev({ at: 1, subId: 'a', name: 'ProcessKpi', status: 'ok' }),
      ev({ at: 2, subId: 'b', name: 'ProcessKpi', status: 'ok' }),
    ]);
    expect(subs.map((s) => s.id)).toEqual(['a', 'b']);
    expect(subs).toHaveLength(2);
  });

  it('groups phases, logs and terminal under one subId; derives duration and startedAt', () => {
    const { subs } = groupSubProcesses([
      ev({ at: 100, subId: 'r1', name: 'ProcessKpi', group: 'af_fleet', phase: 'triggered' }),
      ev({ at: 120, subId: 'r1', level: 'debug', message: 'Querying MCR data' }),
      ev({ at: 150, subId: 'r1', name: 'ProcessKpi', phase: 'processing' }),
      ev({ at: 964, subId: 'r1', name: 'ProcessKpi', status: 'ok' }),
    ]);
    expect(subs).toHaveLength(1);
    const s = subs[0];
    expect(s).toMatchObject({ id: 'r1', name: 'ProcessKpi', group: 'af_fleet', status: 'ok' });
    expect(s.phases.map((p) => p.phase)).toEqual(['triggered', 'processing']);
    expect(s.logs.map((l) => l.message)).toEqual(['Querying MCR data']);
    expect(s.startedAt).toBe(100);
    expect(s.durationMs).toBe(864); // 964 - 100
  });

  it('data.durationMs on the terminal overrides the derived duration', () => {
    const { subs } = groupSubProcesses([
      ev({ at: 100, subId: 'r1', name: 'P', phase: 'processing' }),
      ev({ at: 999, subId: 'r1', name: 'P', status: 'ok', data: { durationMs: 42 } }),
    ]);
    expect(subs[0].durationMs).toBe(42);
  });

  it('a log line with no owner is a step-level log', () => {
    const { subs, stepLogs } = groupSubProcesses([
      ev({ at: 1, level: 'info', message: 'step started' }),
    ]);
    expect(subs).toEqual([]);
    expect(stepLogs.map((l) => l.message)).toEqual(['step started']);
  });

  it('legacy `process`-tagged logs group under a name-keyed sub', () => {
    const { subs } = groupSubProcesses([
      ev({ at: 1, name: 'ProcessKpi', status: 'ok' }),
      ev({ at: 2, level: 'debug', message: 'old log', process: 'ProcessKpi' }),
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0].logs.map((l) => l.message)).toEqual(['old log']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/dashboard/src/client/group-subprocesses.spec.ts`
Expected: FAIL — cannot find module `./group-subprocesses`.

- [ ] **Step 3: Implement `groupSubProcesses`**

Create `packages/dashboard/src/client/group-subprocesses.ts`:

```ts
import type { StepEvent } from './durable-client';

/** A sub-process reconstructed from a step's events, keyed by run identity. */
export interface SubProcess {
  id: string;
  name: string;
  group?: string;
  /** Intermediate transitions (events carrying a `phase`), in arrival order. */
  phases: StepEvent[];
  /** Log lines owned by this sub-process (no `phase`, no `status`), in arrival order. */
  logs: StepEvent[];
  /** The terminal event (carries a `status`), if the sub has finished. */
  terminal?: StepEvent;
  status?: 'ok' | 'failed' | 'skipped';
  /** Earliest `at` across this sub's events. */
  startedAt?: number;
  /** `data.durationMs` when provided, else `terminal.at − startedAt`. */
  durationMs?: number;
}

function durationFromData(data: unknown): number | undefined {
  if (typeof data === 'object' && data !== null && 'durationMs' in data) {
    const value = (data as Record<string, unknown>).durationMs;
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Group a step's events into sub-processes by run identity (`subId`, falling back to `name` then the
 * legacy `process` tag). Events with no owner (step-level logs) are returned separately. `Map`
 * iteration preserves first-seen order, so subs come back in the order they first appeared.
 */
export function groupSubProcesses(events: StepEvent[]): {
  subs: SubProcess[];
  stepLogs: StepEvent[];
} {
  const byId = new Map<string, SubProcess>();
  const stepLogs: StepEvent[] = [];

  for (const event of events) {
    const key = event.subId ?? event.name ?? event.process;
    const ownedBySub =
      key !== undefined &&
      (event.subId !== undefined ||
        event.name !== undefined ||
        event.status !== undefined ||
        event.phase !== undefined ||
        event.process !== undefined);
    if (!ownedBySub || key === undefined) {
      stepLogs.push(event);
      continue;
    }
    const existing = byId.get(key);
    const sub: SubProcess = existing ?? { id: key, name: event.name ?? key, phases: [], logs: [] };
    if (!existing) byId.set(key, sub);
    if (event.name) sub.name = event.name;
    if (event.group !== undefined) sub.group = event.group;
    if (event.status !== undefined) {
      sub.terminal = event;
      sub.status = event.status;
    } else if (event.phase !== undefined) {
      sub.phases.push(event);
    } else {
      sub.logs.push(event);
    }
  }

  const subs = [...byId.values()].map((sub) => {
    const stamps = [...sub.phases, ...sub.logs, ...(sub.terminal ? [sub.terminal] : [])].map(
      (e) => e.at,
    );
    const startedAt = stamps.length ? Math.min(...stamps) : undefined;
    const fromData = durationFromData(sub.terminal?.data);
    const durationMs =
      fromData ??
      (sub.terminal && startedAt !== undefined ? sub.terminal.at - startedAt : undefined);
    return { ...sub, startedAt, durationMs };
  });

  return { subs, stepLogs };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/dashboard/src/client/group-subprocesses.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/client/group-subprocesses.ts packages/dashboard/src/client/group-subprocesses.spec.ts
git commit -m "feat(dashboard): groupSubProcesses — group step events by run identity"
```

---

### Task 5: Render sub-processes as accordions in `StepDetailPanel`

Replace the flat `StepEvents` block (`packages/dashboard/src/app/StepDetailPanel.tsx:58-128`) so each
sub-process is an expandable row: name + duration + status badge; expand → phase timeline + error +
that sub's own logs. Step-level logs keep the existing combined logs box. No unit test (React; repo
convention) — verified by typecheck + build.

**Files:**
- Modify: `packages/dashboard/src/app/StepDetailPanel.tsx` (imports, the `StepEvents` component, and `groupLogsByProcess` which is superseded)

- [ ] **Step 1: Import the grouping helper and `SubProcess` type**

At the top of `StepDetailPanel.tsx`, change the client import to add the helper:

```ts
import type { StepCheckpoint, StepEvent, WorkflowRun } from '../client/durable-client';
import { groupSubProcesses, type SubProcess } from '../client/group-subprocesses';
```

- [ ] **Step 2: Replace `groupLogsByProcess` and `StepEvents` with the accordion implementation**

Delete `groupLogsByProcess` (lines ~43-56) and replace the whole `StepEvents` component (lines ~58-128) with:

```tsx
const SUB_DOT: Record<NonNullable<StepEvent['status']>, string> = {
  ok: 'bg-emerald-400',
  failed: 'bg-red-400',
  skipped: 'bg-amber-400',
};

const SUB_ORDER: Array<NonNullable<StepEvent['status']>> = ['ok', 'failed', 'skipped'];

/** One sub-process: a clickable row (name · duration · status) that expands to its phase timeline,
 *  error, and owned log lines. Mirrors flip's per-process expand in `pipeline-runs`. */
function SubProcessRow({ sub }: { sub: SubProcess }) {
  const expandable = sub.phases.length > 0 || sub.logs.length > 0 || !!sub.terminal?.error;
  const [open, setOpen] = useState(sub.status === 'failed'); // surface failures without a click
  const tone = sub.status ? SUB_TONE[sub.status] : 'border-amber-500/25 bg-amber-500/10 text-amber-300';

  return (
    <li className={`rounded-md border ${tone}`}>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[11.5px] disabled:cursor-default"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          {expandable && (
            <span className={`text-[9px] text-zinc-500 transition-transform ${open ? '' : '-rotate-90'}`}>
              ▼
            </span>
          )}
          <span className="mono truncate text-zinc-200">{sub.name}</span>
          {sub.group && (
            <span className="mono shrink-0 text-[10px] uppercase tracking-wider text-zinc-500">
              {sub.group}
            </span>
          )}
        </span>
        <span className="mono flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-wider">
          {sub.durationMs !== undefined && (
            <span className="tnum text-zinc-400">{fmtMs(sub.durationMs)}</span>
          )}
          <span>{sub.status ?? 'running'}</span>
        </span>
      </button>

      {open && (
        <div className="border-t border-[var(--line)]/60 px-2.5 py-2">
          {sub.phases.length > 0 && (
            <ul className="mono mb-2 flex flex-col gap-0.5 text-[10.5px]">
              {sub.phases.map((p) => (
                <li key={`${p.at}-${p.phase}`} className="flex gap-2">
                  <span className="shrink-0 text-zinc-600 tnum">{clockMs(p.at)}</span>
                  <span className="text-zinc-400">{p.phase}</span>
                  {sub.startedAt !== undefined && (
                    <span className="text-zinc-600 tnum">+{fmtMs(p.at - sub.startedAt)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {sub.terminal?.error && (
            <div className="mono mb-2 rounded border border-red-500/25 bg-red-500/10 p-2 text-[11px] text-red-200">
              {sub.terminal.error.message}
            </div>
          )}
          {sub.logs.length > 0 && (
            <ul className="mono flex flex-col gap-0.5 text-[11px]">
              {sub.logs.map((e) => (
                <li key={`${e.at}-${e.message}`} className="flex gap-2 py-0.5">
                  <span className="shrink-0 text-zinc-600 tnum">{clockMs(e.at)}</span>
                  <span className={`shrink-0 uppercase ${LEVEL_TONE[e.level]}`}>{e.level}</span>
                  <span className="min-w-0 break-words text-zinc-300">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** Sub-process outcomes + the step's log lines. Each sub-process is an expandable row showing its
 *  lifecycle (phases), duration, terminal status, error, and owned logs. */
function StepEvents({ events }: { events: StepEvent[] }) {
  const { subs, stepLogs } = groupSubProcesses(events);
  const counts = SUB_ORDER.map(
    (s) => [s, subs.filter((sub) => sub.status === s).length] as const,
  ).filter(([, n]) => n > 0);
  const grouped = subs.some((s) => s.group);

  return (
    <>
      {subs.length > 0 && (
        <section className="rise">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
              sub-processes · {subs.length}
            </span>
            <span className="mono flex gap-2 text-[10px] uppercase tracking-wider">
              {counts.map(([s, n]) => (
                <span key={s} className={SUB_TONE[s].split(' ').pop()}>
                  {n} {s}
                </span>
              ))}
            </span>
          </div>
          {grouped
            ? Object.entries(
                subs.reduce<Record<string, SubProcess[]>>((acc, sub) => {
                  const key = sub.group ?? '—';
                  (acc[key] ??= []).push(sub);
                  return acc;
                }, {}),
              ).map(([group, groupSubs]) => (
                <div key={group} className="mb-2">
                  <div className="mono mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                    {group}
                  </div>
                  <ul className="flex flex-col gap-1">
                    {groupSubs.map((sub) => (
                      <SubProcessRow key={sub.id} sub={sub} />
                    ))}
                  </ul>
                </div>
              ))
            : (
              <ul className="flex flex-col gap-1">
                {subs.map((sub) => (
                  <SubProcessRow key={sub.id} sub={sub} />
                ))}
              </ul>
            )}
        </section>
      )}

      {stepLogs.length > 0 && (
        <section className="rise">
          <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
            logs · {stepLogs.length}
          </div>
          <div className="mono max-h-64 overflow-auto rounded-lg border border-[var(--line)] bg-black/40 p-2.5 text-[11px] leading-relaxed">
            {stepLogs.map((e) => (
              <div key={`${e.at}-${e.message}`} className="flex gap-2 py-0.5">
                <span className="shrink-0 text-zinc-600 tnum">{clockMs(e.at)}</span>
                <span className={`shrink-0 uppercase ${LEVEL_TONE[e.level]}`}>{e.level}</span>
                <span className="min-w-0 break-words text-zinc-300">{e.message}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
```

> Note: `SubProcess` does not yet expose `terminal.error`. `StepEvent` has no `error` field — a
> failed sub carries its message in `message`/`data`. In Step 3, adjust the error block to read
> `sub.status === 'failed'` and render `sub.terminal?.message` instead of `sub.terminal?.error`.

- [ ] **Step 3: Fix the failed-sub error rendering to use `message`**

In the `SubProcessRow` expanded block, replace the `sub.terminal?.error` block with:

```tsx
          {sub.status === 'failed' && sub.terminal?.message && (
            <div className="mono mb-2 rounded border border-red-500/25 bg-red-500/10 p-2 text-[11px] text-red-200">
              {sub.terminal.message}
            </div>
          )}
```

And update `expandable` in `SubProcessRow` to:

```tsx
  const expandable =
    sub.phases.length > 0 || sub.logs.length > 0 || sub.status === 'failed';
```

- [ ] **Step 4: Typecheck the dashboard**

Run: `pnpm --filter @dudousxd/nestjs-durable-dashboard typecheck`
Expected: PASS. (If `SUB_TONE` / `LEVEL_TONE` / `fmtMs` / `clockMs` are reported unused or missing, they already exist at the top of the file from the original `StepEvents` — keep them.)

- [ ] **Step 5: Build the dashboard (compiles the SPA)**

Run: `pnpm --filter @dudousxd/nestjs-durable-dashboard build`
Expected: PASS (vite build + tsc).

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/app/StepDetailPanel.tsx
git commit -m "feat(dashboard): render sub-processes as expandable lifecycle rows"
```

---

### Task 6: Changeset + full verification

**Files:**
- Create: `.changeset/subprocess-lifecycle.md`

- [ ] **Step 1: Add a changeset (minor bump for core + dashboard)**

Create `.changeset/subprocess-lifecycle.md`:

```markdown
---
'@dudousxd/nestjs-durable-core': minor
'@dudousxd/nestjs-durable-dashboard': minor
---

Extensible sub-process model: `StepEvent` gains optional `subId` (run identity), `group`, and `phase`
fields, and `StepLogger` gains `subEvent()` for emitting per-sub-process phase transitions and a
terminal outcome. The dashboard renders each sub-process as an expandable lifecycle row (phases,
duration, status, error, owned logs) grouped by run identity. The existing `sub(name, status)` is
unchanged.
```

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`
Expected: PASS — including the new `step-logger.spec.ts` (3) and `group-subprocesses.spec.ts` (6).

- [ ] **Step 3: Typecheck all packages**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Lint/format check**

Run: `pnpm lint`
Expected: PASS. If it reports formatting, run `pnpm lint:fix` and re-stage.

- [ ] **Step 5: Commit**

```bash
git add .changeset/subprocess-lifecycle.md
git commit -m "chore: changeset for extensible sub-process lifecycle"
```

- [ ] **Step 6: Push (release runs in CI on merge to main — do NOT publish by hand)**

```bash
git push
```

> Release is handled by the changesets GitHub action on merge to `main` (per repo convention). Do not
> run `changeset publish` locally. If the version PR's `biome ci` fails on a re-expanded
> `package.json` `files` array, collapse it with `pnpm format` and push (known monorepo gotcha).

---

## Self-Review

**Spec coverage:**
- Terminal closed enum + open phase → `StepEvent.phase` + closed `status` (Task 1). ✓
- Run identity (`subId`) → Task 1 + grouping in Task 4. ✓
- Open `group` → Task 1 field + Task 5 grouped rendering. ✓
- Discrete live events → phases are plain `StepEvent`s; App.tsx `step.progress` merge appends them unchanged (verified `App.tsx:216-229`, no change needed). ✓
- Back-compat (`sub` unchanged, optional fields, dashboard fallback to `name`/`process`) → Task 2 keeps `sub` byte-identical (test asserts it); Task 4 fallback keys (`subId ?? name ?? process`) + legacy-`process` test. ✓
- Dashboard accordion (phases timeline + duration + status + error + logs; grouped by `group`; counts by distinct `subId`) → Task 5. ✓
- Out-of-scope (double-dispatch, flip wiring) → not in this plan, by design. ✓

**Placeholder scan:** No TBD/TODO; all code shown in full. The Step 2→Step 3 correction in Task 5 (error field) is intentional and concrete, not a placeholder.

**Type consistency:** `groupSubProcesses` returns `{ subs: SubProcess[]; stepLogs: StepEvent[] }` — used consistently in Task 5. `SubProcess` fields (`id`, `name`, `group?`, `phases`, `logs`, `terminal?`, `status?`, `startedAt?`, `durationMs?`) match between Task 4 definition and Task 5 usage. `subEvent` signature identical in Task 1 (interface) and Task 2 (impl) and the changeset. `StepEvent` fields identical across core (Task 1) and dashboard (Task 3).
