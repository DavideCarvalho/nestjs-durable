'use client';

import { useEffect, useState } from 'react';

/* A looping, animated workflow run for the landing page: it plays a happy path, then a step that
   fails and retries, then a cancelled run — over and over. Pure CSS/JS, no data. */

type StepStatus = 'queued' | 'running' | 'done' | 'failed' | 'retry' | 'skipped';
type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

interface Frame {
  run: RunStatus;
  label: string;
  steps: StepStatus[];
}

const STEPS = [
  { name: 'reserveStock', kind: 'local', meta: 'nestjs' },
  { name: 'payments.charge-card', kind: 'remote', meta: '@python' },
  { name: 'sleep · 2 days', kind: 'sleep', meta: 'no compute' },
  { name: 'shipping.dispatch', kind: 'remote', meta: '@logistics' },
  { name: 'notify', kind: 'local', meta: 'nestjs' },
];

function successFrames(): Frame[] {
  const frames: Frame[] = [];
  const steps: StepStatus[] = STEPS.map(() => 'queued');
  for (let i = 0; i < STEPS.length; i += 1) {
    steps[i] = 'running';
    frames.push({ run: 'running', label: 'running', steps: [...steps] });
    steps[i] = 'done';
  }
  frames.push({ run: 'completed', label: 'completed', steps: [...steps] });
  return frames;
}

function retryFrames(at: number): Frame[] {
  const frames: Frame[] = [];
  const steps: StepStatus[] = STEPS.map(() => 'queued');
  for (let i = 0; i < STEPS.length; i += 1) {
    steps[i] = 'running';
    frames.push({ run: 'running', label: 'running', steps: [...steps] });
    if (i === at) {
      steps[i] = 'failed';
      frames.push({ run: 'running', label: 'step failed', steps: [...steps] });
      steps[i] = 'retry';
      frames.push({ run: 'running', label: 'retrying ×2', steps: [...steps] });
    }
    steps[i] = 'done';
  }
  frames.push({ run: 'completed', label: 'completed', steps: [...steps] });
  return frames;
}

function cancelFrames(at: number): Frame[] {
  const frames: Frame[] = [];
  const steps: StepStatus[] = STEPS.map(() => 'queued');
  for (let i = 0; i < at; i += 1) {
    steps[i] = 'running';
    frames.push({ run: 'running', label: 'running', steps: [...steps] });
    steps[i] = 'done';
  }
  steps[at] = 'running';
  frames.push({ run: 'running', label: 'running', steps: [...steps] });
  for (let j = at; j < STEPS.length; j += 1) steps[j] = 'skipped';
  frames.push({ run: 'cancelled', label: 'cancelled', steps: [...steps] });
  return frames;
}

// Flatten the three scenarios, holding the final frame of each for a beat before the next.
function hold(frames: Frame[], beats: number): Frame[] {
  const last = frames[frames.length - 1];
  return last ? [...frames, ...Array.from({ length: beats }, () => last)] : frames;
}

const FRAMES: Frame[] = [
  ...hold(successFrames(), 3),
  ...hold(retryFrames(1), 3),
  ...hold(cancelFrames(3), 3),
];

const RUN_STYLES: Record<RunStatus, string> = {
  running: 'text-sky-400',
  completed: 'text-emerald-400',
  failed: 'text-red-400',
  cancelled: 'text-zinc-500',
};

const DOT_STYLES: Record<StepStatus, string> = {
  queued: 'bg-zinc-700',
  running: 'bg-sky-400',
  done: 'bg-emerald-400',
  failed: 'bg-red-400',
  retry: 'bg-amber-400',
  skipped: 'bg-zinc-800',
};

const STATUS_LABEL: Record<StepStatus, string> = {
  queued: 'queued',
  running: 'running',
  done: 'done',
  failed: 'failed',
  retry: 'retry',
  skipped: '—',
};

const STATUS_TEXT: Record<StepStatus, string> = {
  queued: 'text-zinc-600',
  running: 'text-sky-400',
  done: 'text-emerald-400',
  failed: 'text-red-400',
  retry: 'text-amber-300',
  skipped: 'text-zinc-700',
};

export function LiveRun() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 720);
    return () => clearInterval(id);
  }, []);
  const frame = FRAMES[i] ?? FRAMES[0];

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/40 ring-1 ring-white/5">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-4 py-3">
        <span className="size-3 rounded-full bg-zinc-700" />
        <span className="size-3 rounded-full bg-zinc-700" />
        <span className="size-3 rounded-full bg-zinc-700" />
        <span className="ml-3 font-mono text-xs text-zinc-500">checkout · live</span>
        <span
          className={`ml-auto inline-flex items-center gap-1.5 font-mono text-[11px] ${RUN_STYLES[frame.run]}`}
        >
          <span
            className={`size-1.5 rounded-full ${DOT_STYLES[frame.run === 'running' ? 'running' : frame.run === 'completed' ? 'done' : frame.run === 'failed' ? 'failed' : 'skipped']} ${
              frame.run === 'running' ? 'animate-tele-blink' : ''
            }`}
          />
          {frame.label}
        </span>
      </div>

      <div className="divide-y divide-zinc-800/60 p-2 font-mono text-xs">
        {STEPS.map((step, idx) => {
          const status = frame.steps[idx] ?? 'queued';
          const dim = status === 'queued' || status === 'skipped';
          return (
            <div
              key={step.name}
              className={`flex items-center gap-3 px-2 py-2.5 transition-opacity duration-300 ${dim ? 'opacity-45' : 'opacity-100'}`}
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${DOT_STYLES[status]} ${status === 'running' ? 'animate-tele-blink' : ''}`}
              />
              <span className="w-5 shrink-0 text-zinc-600">{idx}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-300">{step.name}</span>
              <span className="hidden shrink-0 rounded border border-zinc-800 px-1 text-[10px] uppercase tracking-wide text-zinc-500 sm:inline">
                {step.kind}
              </span>
              <span className="hidden w-20 shrink-0 text-zinc-600 md:inline">{step.meta}</span>
              <span className={`w-16 shrink-0 text-right ${STATUS_TEXT[status]}`}>
                {STATUS_LABEL[status]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
