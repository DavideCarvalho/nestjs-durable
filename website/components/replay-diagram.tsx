'use client';

// Interactive checkpoint-and-replay illustration for the durability docs. Hand-authored SVG, no
// animation deps — plain React state + CSS transitions. Reads top-to-bottom as time across three
// column-aligned bands (first run → checkpoint store → replay after crash). Play/step/scrub walks
// logical time; the 💥 crash marker is draggable and reshapes what replay re-runs vs returns saved.
//
// Degrades without JS: SSR renders the fully-resolved frame (a readable static diagram). Theme-aware
// via Fumadocs' `--color-fd-*` variables; respects `prefers-reduced-motion`.

import { useEffect, useMemo, useRef, useState } from 'react';

const ink = 'var(--color-fd-foreground)';
const muted = 'var(--color-fd-muted-foreground)';
const card = 'var(--color-fd-card)';
const border = 'var(--color-fd-border)';
const accent = 'var(--color-fd-primary)';
const accentSoft = 'color-mix(in srgb, var(--color-fd-primary) 14%, transparent)';
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const COLS = [200, 410, 620];
const CELL_W = 156;
const SLOT_W = 150;
const N = 3;
const STEPS = [
  { idx: 'step[0]', name: 'reserveStock' },
  { idx: 'step[1]', name: 'chargeCard' },
  { idx: 'step[2]', name: 'ship' },
];

// Snap x for the crash marker when `checkpointedCount` = C (0..N): to the right of the last
// checkpointed step, i.e. just left of column C (or past the last column when C === N).
const BOUNDARY_X = [
  COLS[0] - CELL_W / 2 - 15,
  (COLS[0] + COLS[1]) / 2,
  (COLS[1] + COLS[2]) / 2,
  COLS[2] + CELL_W / 2 + 15,
];

type Ev =
  | { kind: 'exec-first'; step: number }
  | { kind: 'crash' }
  | { kind: 'restart' }
  | { kind: 'return'; step: number }
  | { kind: 'exec-replay'; step: number };

function buildEvents(checkpointedCount: number): Ev[] {
  const ev: Ev[] = [];
  for (let i = 0; i < checkpointedCount; i++) ev.push({ kind: 'exec-first', step: i });
  ev.push({ kind: 'crash' });
  ev.push({ kind: 'restart' });
  for (let i = 0; i < N; i++) {
    ev.push(i < checkpointedCount ? { kind: 'return', step: i } : { kind: 'exec-replay', step: i });
  }
  return ev;
}

function caption(e: Ev | undefined): string {
  if (!e) return 'Ready — press play, or drag 💥 to move the crash.';
  switch (e.kind) {
    case 'exec-first':
      return `First run: execute ${STEPS[e.step].name} → write checkpoint seq:${e.step}`;
    case 'crash':
      return '💥 crash — the process dies mid-run.';
    case 'restart':
      return 'Engine restarts and resumes the run from the top.';
    case 'return':
      return `Replay: ${STEPS[e.step].name} has a completed checkpoint → return saved output (not re-run).`;
    case 'exec-replay':
      return `Replay: ${STEPS[e.step].name} has no checkpoint → execute for real.`;
  }
}

/** A step cell (first-run or replay band). */
function Cell({
  cx,
  y,
  h,
  tone,
  active,
  title,
  sub,
}: {
  cx: number;
  y: number;
  h: number;
  tone: 'exec' | 'saved' | 'idle';
  active: boolean;
  title: string;
  sub: string;
}) {
  const x = cx - CELL_W / 2;
  const isExec = tone === 'exec';
  const stroke = isExec && active ? accent : border;
  const dashed = !(isExec && active);
  const opacity = active ? 1 : tone === 'idle' ? 0.4 : 0.5;
  const titleFill = tone === 'saved' ? muted : active || tone !== 'exec' ? ink : muted;
  return (
    <g className="rd-anim" style={{ opacity }}>
      <rect
        x={x}
        y={y}
        width={CELL_W}
        height={h}
        rx={10}
        className="rd-anim"
        style={{
          fill: card,
          stroke,
          strokeWidth: isExec && active ? 1.5 : 1,
          strokeDasharray: dashed ? '4 3' : undefined,
        }}
        filter="url(#rd-soft)"
      />
      {isExec && active ? (
        <rect x={x} y={y} width={4} height={h} rx={2} style={{ fill: accent }} />
      ) : null}
      <text
        x={cx}
        y={y + 26}
        textAnchor="middle"
        style={{ fill: titleFill, fontSize: 12.5, fontWeight: 600 }}
      >
        {title}
      </text>
      <text
        x={cx}
        y={y + 44}
        textAnchor="middle"
        style={{ fill: muted, fontSize: 10.5, fontFamily: mono }}
      >
        {sub}
      </text>
    </g>
  );
}

/** A checkpoint slot in the store lane. */
function Slot({ cx, y, filled, seq }: { cx: number; y: number; filled: boolean; seq: number }) {
  const x = cx - SLOT_W / 2;
  return (
    <g className="rd-anim">
      <rect
        x={x}
        y={y}
        width={SLOT_W}
        height={44}
        rx={8}
        className="rd-anim"
        style={{
          fill: filled ? accentSoft : card,
          stroke: border,
          strokeWidth: 1,
          strokeDasharray: filled ? undefined : '4 3',
        }}
      />
      <text
        x={cx}
        y={y + 18}
        textAnchor="middle"
        className="rd-anim"
        style={{ fill: filled ? ink : muted, fontSize: 10.5, fontWeight: 600, fontFamily: mono }}
      >
        {filled ? `seq:${seq} · completed` : `seq:${seq} · none`}
      </text>
      <text
        x={cx}
        y={y + 33}
        textAnchor="middle"
        style={{ fill: muted, fontSize: 10, fontFamily: mono }}
      >
        {filled ? 'saved output' : '—'}
      </text>
    </g>
  );
}

/** A short vertical connector; arrowhead sits at (cx, y2). */
function VArrow({
  cx,
  y1,
  y2,
  label,
  shown,
}: {
  cx: number;
  y1: number;
  y2: number;
  label?: string;
  shown: boolean;
}) {
  return (
    <g className="rd-anim" style={{ opacity: shown ? 1 : 0.15 }}>
      <line
        x1={cx}
        y1={y1}
        x2={cx}
        y2={y2}
        style={{ stroke: muted, strokeWidth: 1.5 }}
        markerEnd="url(#rd-arrow)"
      />
      {label ? (
        <text
          x={cx - 9}
          y={(y1 + y2) / 2 + 3}
          textAnchor="end"
          style={{ fill: muted, fontSize: 9.5, fontFamily: mono }}
        >
          {label}
        </text>
      ) : null}
    </g>
  );
}

export function ReplayDiagram() {
  const [checkpointed, setCheckpointed] = useState(2);
  const [t, setT] = useState(999); // clamped below → SSR/first paint shows the resolved frame
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const events = useMemo(() => buildEvents(checkpointed), [checkpointed]);
  const tc = Math.min(t, events.length);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    if (!playing) return;
    if (tc >= events.length) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setT((v) => Math.min(events.length, v + 1)), reduced ? 320 : 850);
    return () => clearTimeout(id);
  }, [playing, tc, events.length, reduced]);

  function resetTo(count: number) {
    setCheckpointed(count);
    setT(0);
    setPlaying(false);
  }

  function dragCrash(clientX: number) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 720;
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let c = 0; c <= N; c++) {
      const d = Math.abs(BOUNDARY_X[c] - x);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best !== checkpointed) resetTo(best);
  }

  function onHandleDown(e: React.PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => dragCrash(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onHandleKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      resetTo(Math.min(N, checkpointed + 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      resetTo(Math.max(0, checkpointed - 1));
    }
  }

  const applied = events.slice(0, tc);
  const has = (pred: (e: Ev) => boolean) => applied.some(pred);
  const firstDone = (i: number) => has((e) => e.kind === 'exec-first' && e.step === i);
  const returned = (i: number) => has((e) => e.kind === 'return' && e.step === i);
  const replayed = (i: number) => has((e) => e.kind === 'exec-replay' && e.step === i);
  const storeFilled = (i: number) => firstDone(i) || replayed(i);
  const crashed = has((e) => e.kind === 'crash');
  const restarted = has((e) => e.kind === 'restart');
  const phase: 'first' | 'crash' | 'replay' = !crashed ? 'first' : !restarted ? 'crash' : 'replay';
  const current = tc > 0 ? events[tc - 1] : undefined;

  const crashX = BOUNDARY_X[checkpointed];
  const btn = {
    font: 'inherit',
    fontSize: 12.5,
    color: 'var(--color-fd-foreground)',
    background: 'var(--color-fd-card)',
    border: '1px solid var(--color-fd-border)',
    borderRadius: 8,
    padding: '4px 12px',
    cursor: 'pointer',
  } as const;

  return (
    <figure className="my-6 overflow-hidden rounded-xl border border-fd-border bg-fd-card p-4">
      <style>{`
        .rd-anim { transition: opacity .35s ease, fill .35s ease, stroke .35s ease, stroke-width .35s ease; }
        .rd-ping { animation: rd-ping 1s ease-out forwards; }
        @keyframes rd-ping { 0% { opacity: .5 } 70%, 100% { opacity: 0 } }
        @media (prefers-reduced-motion: reduce) {
          .rd-anim { transition: none }
          .rd-ping { animation: none; opacity: 0 }
        }
      `}</style>
      <svg
        ref={svgRef}
        viewBox="0 0 720 292"
        width="100%"
        role="img"
        aria-label="Interactive checkpoint and deterministic replay across a crash"
      >
        <title>
          The first run executes each step and writes a checkpoint; after a crash, replay returns
          the saved output for completed checkpoints and executes only the step that has none. Drag
          the crash marker to change how many checkpoints exist before the crash.
        </title>
        <defs>
          <marker
            id="rd-arrow"
            viewBox="0 0 10 10"
            refX={8}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: muted }} />
          </marker>
          <filter id="rd-soft" x="-8%" y="-8%" width="116%" height="130%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.12" />
          </filter>
        </defs>

        {COLS.map((cx) => (
          <line
            key={`guide-${cx}`}
            x1={cx}
            y1={40}
            x2={cx}
            y2={272}
            style={{ stroke: border, strokeWidth: 1, strokeDasharray: '2 5', opacity: 0.7 }}
          />
        ))}

        {STEPS.map((step, i) => (
          <g key={step.idx}>
            <text
              x={COLS[i]}
              y={16}
              textAnchor="middle"
              style={{ fill: ink, fontSize: 11, fontWeight: 700 }}
            >
              {step.idx}
            </text>
            <text
              x={COLS[i]}
              y={31}
              textAnchor="middle"
              style={{ fill: muted, fontSize: 10.5, fontFamily: mono }}
            >
              {step.name}
            </text>
          </g>
        ))}

        <text x={12} y={83} style={{ fill: ink, fontSize: 11, fontWeight: 600 }}>
          First run
        </text>
        <text x={12} y={152} style={{ fill: muted, fontSize: 10.5, fontWeight: 600 }}>
          Checkpoint
        </text>
        <text x={12} y={165} style={{ fill: muted, fontSize: 10.5, fontWeight: 600 }}>
          store
        </text>
        <text x={12} y={232} style={{ fill: ink, fontSize: 11, fontWeight: 600 }}>
          Replay
        </text>
        <text x={12} y={245} style={{ fill: muted, fontSize: 10.5 }}>
          after crash
        </text>

        {/* First-run band. */}
        <g className="rd-anim" style={{ opacity: phase === 'replay' ? 0.5 : 1 }}>
          {STEPS.map((step, i) =>
            i < checkpointed ? (
              <Cell
                key={`fr-${step.idx}`}
                cx={COLS[i]}
                y={48}
                h={62}
                tone="exec"
                active={firstDone(i)}
                title="execute"
                sub="→ checkpoint"
              />
            ) : (
              <Cell
                key={`fr-${step.idx}`}
                cx={COLS[i]}
                y={48}
                h={62}
                tone="idle"
                active={false}
                title="not reached"
                sub="—"
              />
            ),
          )}
        </g>

        {/* Checkpoint store. */}
        {STEPS.map((step, i) => (
          <Slot key={`slot-${step.idx}`} cx={COLS[i]} y={134} filled={storeFilled(i)} seq={i} />
        ))}

        {/* Replay band. */}
        <g className="rd-anim" style={{ opacity: phase === 'first' ? 0.4 : 1 }}>
          {STEPS.map((step, i) =>
            i < checkpointed ? (
              <Cell
                key={`rp-${step.idx}`}
                cx={COLS[i]}
                y={204}
                h={64}
                tone="saved"
                active={returned(i)}
                title="return saved"
                sub="not re-run"
              />
            ) : (
              <Cell
                key={`rp-${step.idx}`}
                cx={COLS[i]}
                y={204}
                h={64}
                tone="exec"
                active={replayed(i)}
                title="execute for real"
                sub="no checkpoint"
              />
            ),
          )}
        </g>

        {/* Data-flow arrows. */}
        {STEPS.map((step, i) =>
          i < checkpointed ? (
            <g key={`arr-${step.idx}`}>
              <VArrow
                cx={COLS[i]}
                y1={110}
                y2={134}
                label={i === 0 ? 'write' : undefined}
                shown={firstDone(i)}
              />
              <VArrow
                cx={COLS[i]}
                y1={178}
                y2={204}
                label={i === 0 ? 'return' : undefined}
                shown={returned(i)}
              />
            </g>
          ) : (
            <VArrow key={`arr-${step.idx}`} cx={COLS[i]} y1={204} y2={178} shown={replayed(i)} />
          ),
        )}

        {/* Ping ring on the element the current beat touched. */}
        {current && (current.kind === 'exec-first' || current.kind === 'exec-replay') ? (
          <rect
            key={`ping-${tc}`}
            className="rd-ping"
            x={COLS[current.step] - CELL_W / 2 - 3}
            y={(current.kind === 'exec-first' ? 48 : 204) - 3}
            width={CELL_W + 6}
            height={(current.kind === 'exec-first' ? 62 : 64) + 6}
            rx={12}
            style={{ fill: 'none', stroke: accent, strokeWidth: 2 }}
          />
        ) : null}

        {/* Draggable crash marker. */}
        <g
          role="slider"
          tabIndex={0}
          aria-label="Crash point — number of checkpoints written before the crash"
          aria-valuemin={0}
          aria-valuemax={N}
          aria-valuenow={checkpointed}
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKey}
          style={{ cursor: 'ew-resize', outline: 'none' }}
          className="rd-anim"
        >
          <line
            x1={crashX}
            y1={42}
            x2={crashX}
            y2={118}
            className="rd-anim"
            style={{
              stroke: accent,
              strokeWidth: 2,
              strokeDasharray: '5 4',
              opacity: phase === 'crash' ? 1 : 0.85,
            }}
          />
          <rect
            x={crashX - 16}
            y={30}
            width={32}
            height={22}
            rx={6}
            className="rd-anim"
            style={{ fill: card, stroke: accent, strokeWidth: 1.5 }}
          />
          <text x={crashX} y={45} textAnchor="middle" style={{ fontSize: 13 }}>
            💥
          </text>
          {/* Wide invisible hit target for easy grabbing. */}
          <rect x={crashX - 18} y={28} width={36} height={94} style={{ fill: 'transparent' }} />
        </g>
      </svg>

      {/* Controls. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          marginTop: 12,
        }}
      >
        <button
          type="button"
          style={btn}
          onClick={() => {
            if (tc >= events.length) setT(0);
            setPlaying((p) => !p);
          }}
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button
          type="button"
          style={btn}
          onClick={() => {
            setPlaying(false);
            setT((v) => Math.min(events.length, Math.min(v, events.length) + 1));
          }}
        >
          ⏭ Step
        </button>
        <button
          type="button"
          style={btn}
          onClick={() => {
            setPlaying(false);
            setT(0);
          }}
        >
          ⟲ Reset
        </button>
        <input
          type="range"
          min={0}
          max={events.length}
          value={tc}
          aria-label="Scrub logical time"
          onChange={(e) => {
            setPlaying(false);
            setT(Number(e.target.value));
          }}
          style={{ flex: '1 1 140px', minWidth: 120, accentColor: 'var(--color-fd-primary)' }}
        />
      </div>
      <figcaption
        className="mt-2 border-t border-fd-border px-1 pt-2 text-xs text-fd-muted-foreground"
        aria-live="polite"
      >
        {caption(current)} <span style={{ opacity: 0.7 }}>Drag 💥 to move the crash.</span>
      </figcaption>
    </figure>
  );
}
