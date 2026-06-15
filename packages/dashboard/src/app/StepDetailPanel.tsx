import { useState } from 'react';
import type { StepCheckpoint, StepEvent, WorkflowRun } from '../client/durable-client';
import { BoltIcon, CheckIcon, CopyIcon, KIND_LABEL, XIcon, iconFor } from './icons';

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

function fmtDur(a: string, b: string): string {
  return fmtMs(new Date(b).getTime() - new Date(a).getTime());
}

function clock(iso: string): string {
  return clockMs(new Date(iso).getTime());
}

function clockMs(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

const SUB_TONE: Record<NonNullable<StepEvent['status']>, string> = {
  ok: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  failed: 'border-red-500/25 bg-red-500/10 text-red-300',
  skipped: 'border-amber-500/25 bg-amber-500/10 text-amber-300',
};

const LEVEL_TONE: Record<StepEvent['level'], string> = {
  debug: 'text-zinc-500',
  info: 'text-zinc-300',
  warn: 'text-amber-300',
  error: 'text-red-300',
};

const SUB_ORDER: Array<NonNullable<StepEvent['status']>> = ['ok', 'failed', 'skipped'];

/** Collapse a step's log lines into consecutive runs sharing the same owning sub-process (`process`),
 *  preserving chronological order. A fan-out step's trail then reads grouped per p-process; logs with
 *  no `process` (step-level lines, or a worker that doesn't tag) stay in their own ungrouped run. */
function groupLogsByProcess(
  logs: StepEvent[],
): Array<{ process?: string; logs: StepEvent[] }> {
  const groups: Array<{ process?: string; logs: StepEvent[] }> = [];
  for (const log of logs) {
    const last = groups[groups.length - 1];
    if (last && last.process === log.process) last.logs.push(log);
    else groups.push({ process: log.process, logs: [log] });
  }
  return groups;
}

/** Sub-process outcomes (ok/failed/skipped) and the log lines a step emitted, e.g. one row per
 *  parallel p-process so you can see which succeeded, failed, or weren't validated. */
function StepEvents({ events }: { events: StepEvent[] }) {
  const subs = events.filter((e) => e.status);
  const logs = events.filter((e) => !e.status);
  const counts = SUB_ORDER.map(
    (s) => [s, subs.filter((e) => e.status === s).length] as const,
  ).filter(([, n]) => n > 0);

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
          <ul className="flex flex-col gap-1">
            {subs.map((e) => (
              <li
                key={`${e.at}-${e.name}`}
                className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-[11.5px] ${SUB_TONE[e.status as NonNullable<StepEvent['status']>]}`}
              >
                <span className="mono truncate text-zinc-200">{e.name}</span>
                <span className="mono shrink-0 text-[10px] uppercase tracking-wider">
                  {e.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {logs.length > 0 && (
        <section className="rise">
          <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
            logs · {logs.length}
          </div>
          <div className="mono max-h-64 overflow-auto rounded-lg border border-[var(--line)] bg-black/40 p-2.5 text-[11px] leading-relaxed">
            {groupLogsByProcess(logs).map((group, gi) => (
              <ul key={`${group.process ?? 'step'}-${gi}`} className={gi > 0 ? 'mt-2' : ''}>
                {/* Logs a worker tagged with their owning sub-process group under it, so a fan-out
                    step (e.g. `all` → many p-processes) reads as a per-process trail, not one blur. */}
                {group.process && (
                  <li className="sticky top-0 -mx-2.5 mb-0.5 bg-black/40 px-2.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 backdrop-blur">
                    {group.process}
                  </li>
                )}
                {group.logs.map((e) => (
                  <li key={`${e.at}-${e.message}`} className="flex gap-2 py-0.5">
                    <span className="shrink-0 text-zinc-600 tnum">{clockMs(e.at)}</span>
                    <span className={`shrink-0 uppercase ${LEVEL_TONE[e.level]}`}>{e.level}</span>
                    <span className="min-w-0 break-words text-zinc-300">{e.message}</span>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="flex items-center gap-1 rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-200"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard may be blocked in insecure contexts — ignore */
        }
      }}
    >
      {done ? <CheckIcon width={11} height={11} /> : <CopyIcon width={11} height={11} />}
      {done ? 'copied' : 'copy'}
    </button>
  );
}

export function Json({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <section className="rise">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">{label}</span>
        <CopyButton value={text} />
      </div>
      <pre className="mono max-h-64 overflow-auto rounded-lg border border-[var(--line)] bg-black/40 p-3 text-[11.5px] leading-relaxed text-zinc-300">
        {text}
      </pre>
    </section>
  );
}

function Field({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="mono shrink-0 text-[10px] uppercase tracking-[0.16em] text-zinc-600">
        {k}
      </span>
      <span className={`truncate text-right text-[12px] text-zinc-200 ${mono ? 'mono tnum' : ''}`}>
        {v}
      </span>
    </div>
  );
}

export function StepDetailPanel({
  step,
  run,
  onClose,
}: {
  step: StepCheckpoint;
  run: WorkflowRun;
  onClose: () => void;
}) {
  const failed = step.status === 'failed';
  const pending = step.status === 'pending'; // dispatched, awaiting its worker result (in-flight)
  const Icon = iconFor(step.kind);
  const sinceStart = fmtDur(run.createdAt, step.startedAt);
  // Queue-wait: how long the step sat dispatched before a worker picked it up. Only meaningful for
  // a remote step (a local step has enqueuedAt === startedAt, so this is zero and stays hidden).
  const queueMs = step.enqueuedAt
    ? new Date(step.startedAt).getTime() - new Date(step.enqueuedAt).getTime()
    : 0;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-[90%] flex-col border-l border-[var(--line)] bg-[var(--panel)]/95 shadow-2xl backdrop-blur-md rise">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${
                failed
                  ? 'bg-red-500/15 text-red-300'
                  : pending
                    ? 'bg-amber-500/15 text-amber-300'
                    : 'bg-emerald-500/15 text-emerald-300'
              }`}
            >
              <Icon width={13} height={13} />
            </span>
            <h3 className="truncate text-[15px] font-semibold tracking-tight text-zinc-50">
              {step.name}
            </h3>
          </div>
          <div className={`mono mt-1 text-[11px] uppercase tracking-wider s-${step.status}`}>
            {step.status} · {KIND_LABEL[step.kind] ?? step.kind}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-[var(--line)] text-zinc-500 transition-colors hover:text-zinc-200"
          aria-label="Close"
        >
          <XIcon />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
        <div className="rounded-lg border border-[var(--line)] bg-black/20 px-3.5 py-1">
          <Field k="seq" v={`#${step.seq}`} />
          {queueMs >= 1 && (
            <Field k="queued" v={<span className="text-sky-300">{fmtMs(queueMs)}</span>} />
          )}
          <Field
            k="duration"
            v={
              pending ? (
                <span className="text-amber-300">running…</span>
              ) : (
                fmtDur(step.startedAt, step.finishedAt)
              )
            }
          />
          <Field
            k="attempts"
            v={
              <span className={step.attempts > 1 ? 'text-amber-300' : ''}>
                {step.attempts > 1 && <BoltIcon width={11} height={11} className="mr-1 inline" />}
                {step.attempts}
              </span>
            }
          />
          {step.workerGroup && <Field k="worker" v={`@${step.workerGroup}`} />}
          <Field k="started" v={clock(step.startedAt)} />
          <Field k="finished" v={clock(step.finishedAt)} />
          <Field k="offset" v={`+${sinceStart}`} />
        </div>

        {failed && step.error && (
          <section className="rise">
            <div className="mono mb-1.5 text-[10px] uppercase tracking-[0.18em] text-red-400/80">
              error
            </div>
            <div className="mono rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-[11.5px] leading-relaxed text-red-200">
              {step.error.message}
            </div>
          </section>
        )}

        {step.events && step.events.length > 0 && <StepEvents events={step.events} />}

        {step.input !== undefined && <Json label="input" value={step.input} />}
        {step.output !== undefined && <Json label="output" value={step.output} />}
      </div>
    </aside>
  );
}
