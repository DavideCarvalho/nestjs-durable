import { useState } from 'react';
import type { StepCheckpoint, WorkflowRun } from '../client/durable-client';
import { BoltIcon, CheckIcon, CopyIcon, iconFor, KIND_LABEL, XIcon } from './icons';

function fmtDur(a: string, b: string): string {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(2)}m`;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
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
  const Icon = iconFor(step.kind);
  const sinceStart = fmtDur(run.createdAt, step.startedAt);

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-[90%] flex-col border-l border-[var(--line)] bg-[var(--panel)]/95 shadow-2xl backdrop-blur-md rise">
      <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${
                failed
                  ? 'bg-red-500/15 text-red-300'
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
          <Field k="duration" v={fmtDur(step.startedAt, step.finishedAt)} />
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

        {step.output !== undefined && <Json label="output" value={step.output} />}
      </div>
    </aside>
  );
}
