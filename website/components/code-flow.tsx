'use client';

// A synced code↔diagram walkthrough. The left panel shows a code snippet with the
// active line(s) lit; the right panel is a diagram that reacts to the active step;
// a caption explains the line's effect. Play/step/scrub walks the beats. It degrades
// to the resolved (final) frame without JS, is theme-neutral via Fumadocs'
// `--color-fd-*` variables, and respects `prefers-reduced-motion`.

import { type ReactNode, useEffect, useRef, useState } from 'react';

const ink = 'var(--color-fd-foreground)';
const muted = 'var(--color-fd-muted-foreground)';
const accent = 'var(--color-fd-primary)';
const border = 'var(--color-fd-border)';

const AMBER = '#f5a524';
const GREEN = '#30a46c';
const RED = '#e5484d';

const tintAccent = 'color-mix(in srgb, var(--color-fd-primary) 14%, var(--color-fd-card))';
// Semantic tints for PASSED beats — success/failure must read the same on every theme (the aviary
// docs accent is crimson, so theming a "done" check by --color-fd-primary made it look like a fail).
const tintGreen = `color-mix(in srgb, ${GREEN} 15%, var(--color-fd-card))`;
const tintRed = `color-mix(in srgb, ${RED} 15%, var(--color-fd-card))`;
const tintAccentSoft = 'color-mix(in srgb, var(--color-fd-primary) 7%, var(--color-fd-card))';
const neutral = 'color-mix(in srgb, var(--color-fd-foreground) 4%, var(--color-fd-card))';
const codeStr = 'color-mix(in srgb, var(--color-fd-primary) 45%, var(--color-fd-foreground))';
const stepBg = 'color-mix(in srgb, var(--color-fd-foreground) 3%, var(--color-fd-card))';

// ── syntax micro-highlighter ─────────────────────────────────────────────────
const KEYWORDS = new Set([
  'await',
  'async',
  'const',
  'let',
  'return',
  'throw',
  'new',
  'import',
  'export',
  'from',
  'class',
  'function',
  'for',
  'of',
  'if',
  'else',
]);

type Token = { kind: 'text' | 'comment' | 'string' | 'keyword' | 'decorator'; value: string };

function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: Token['kind'], value: string) => {
    if (value) tokens.push({ kind, value });
  };
  while (index < line.length) {
    const rest = line.slice(index);
    const comment = rest.match(/^\/\/.*$/);
    if (comment) {
      push('comment', comment[0]);
      break;
    }
    const str = rest.match(/^(['"`])(?:\\.|(?!\1).)*\1?/);
    if (str) {
      push('string', str[0]);
      index += str[0].length;
      continue;
    }
    const decorator = rest.match(/^@[A-Za-z_$][\w$]*/);
    if (decorator) {
      push('decorator', decorator[0]);
      index += decorator[0].length;
      continue;
    }
    const word = rest.match(/^[A-Za-z_$][\w$]*/);
    if (word) {
      push(KEYWORDS.has(word[0]) ? 'keyword' : 'text', word[0]);
      index += word[0].length;
      continue;
    }
    const other = rest.match(/^[^A-Za-z_$@'"`/]+|^\//);
    const chunk = other ? other[0] : line[index];
    push('text', chunk);
    index += chunk.length;
  }
  return tokens;
}

function tokenColor(kind: Token['kind']): string {
  if (kind === 'comment') return muted;
  if (kind === 'string') return codeStr;
  if (kind === 'keyword') return accent;
  if (kind === 'decorator') return accent;
  return ink;
}

// ── reduced-motion hook ──────────────────────────────────────────────────────
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

// ── stepper ──────────────────────────────────────────────────────────────────
const DWELL_MS = 2400;

function useStepper(count: number) {
  const [index, setIndex] = useState(count - 1); // resolved frame for SSR / no-JS
  const [playing, setPlaying] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (!playing) return;
    if (index >= count - 1) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setIndex((current) => current + 1), reduced ? 900 : DWELL_MS);
    return () => clearTimeout(id);
  }, [playing, index, count, reduced]);

  function play() {
    if (index >= count - 1) setIndex(0);
    setPlaying(true);
  }
  function toggle() {
    playing ? setPlaying(false) : play();
  }
  function go(next: number) {
    setPlaying(false);
    setIndex(Math.max(0, Math.min(count - 1, next)));
  }
  return { index, playing, toggle, go };
}

// ── code panel ───────────────────────────────────────────────────────────────
type Step = {
  lines: [number, number];
  title: string;
  actor: string;
  caption: string;
  stage: string;
  active?: number; // timeline scenes: index of the lit beat
  tone?: 'run' | 'wait' | 'done' | 'fail'; // timeline scenes: the active beat's colour
  attempts?: { done: ('fail' | 'ok')[]; max: number }; // retry scenes: per-attempt marks over the active beat
  child?: ChildState; // child-workflow scenes: parent/child lane state
};

// Two-lane parent↔child state for the ChildDiagram.
type ChildState = {
  pActive: number; // lit parent beat
  cActive: number; // lit child beat, or -1 when the child hasn't started
  arrow?: 'spawn' | 'return'; // which cross-lane arrow is lit this step
  pTone?: 'run' | 'wait' | 'done' | 'fail'; // parent active-beat colour (wait = suspended, fail = dead)
  pDone?: boolean; // parent fully settled (all parent beats done)
  cDone?: boolean; // child fully settled
};

function CodePanel({
  code,
  active,
  onJump,
}: {
  code: string;
  active: [number, number];
  onJump: (line: number) => void;
}) {
  const lines = code.replace(/\n$/, '').split('\n');
  return (
    <pre
      style={{
        margin: 0,
        padding: '14px 2px 14px 0',
        background: 'var(--color-fd-card)',
        border: `1px solid ${border}`,
        borderRadius: 12,
        overflowX: 'auto',
        fontSize: 12.5,
        lineHeight: 1.85,
        fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      }}
    >
      <code>
        {lines.map((line, i) => {
          const lineNo = i + 1;
          const on = lineNo >= active[0] && lineNo <= active[1];
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: rows are a convenience jump; controls below are the primary affordance
            <span
              key={`line-${lineNo}`}
              onClick={() => onJump(lineNo)}
              className="cf-row cf-anim"
              data-on={on}
              style={{
                display: 'flex',
                cursor: 'pointer',
                background: on ? tintAccent : 'transparent',
                boxShadow: on ? `inset 2px 0 0 ${accent}` : 'inset 2px 0 0 transparent',
              }}
            >
              <span
                style={{
                  width: 30,
                  flex: '0 0 30px',
                  textAlign: 'right',
                  paddingRight: 12,
                  color: muted,
                  opacity: on ? 1 : 0.55,
                  userSelect: 'none',
                }}
              >
                {lineNo}
              </span>
              <span style={{ paddingRight: 14, opacity: on ? 1 : 0.62 }} className="cf-anim">
                {tokenize(line).map((token, ti) => (
                  <span key={`t-${lineNo}-${ti}`} style={{ color: tokenColor(token.kind), fontStyle: token.kind === 'comment' ? 'italic' : undefined }}>
                    {token.value}
                  </span>
                ))}
                {line === '' ? ' ' : ''}
              </span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

// ── control bar ──────────────────────────────────────────────────────────────
function ControlBar({
  index,
  count,
  playing,
  onToggle,
  onGo,
}: {
  index: number;
  count: number;
  playing: boolean;
  onToggle: () => void;
  onGo: (next: number) => void;
}) {
  const btn = {
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1,
    color: ink,
    background: 'transparent',
    border: 'none',
    borderRadius: 7,
    padding: '7px 10px',
    cursor: 'pointer',
  } as const;
  const group = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 2,
    background: 'var(--color-fd-card)',
    border: `1px solid ${border}`,
    borderRadius: 9,
    padding: 2,
  } as const;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={group}>
        <button type="button" style={btn} aria-label="Previous step" onClick={() => onGo(index - 1)} disabled={index === 0}>
          ◀
        </button>
        <button type="button" style={{ ...btn, color: accent, fontWeight: 600 }} aria-label={playing ? 'Pause' : 'Play'} onClick={onToggle}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button type="button" style={btn} aria-label="Next step" onClick={() => onGo(index + 1)} disabled={index === count - 1}>
          ▶
        </button>
      </div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        {Array.from({ length: count }, (_, i) => (
          <button
            key={`dot-${i}`}
            type="button"
            aria-label={`Step ${i + 1}`}
            onClick={() => onGo(i)}
            className="cf-anim"
            style={{
              width: i === index ? 22 : 8,
              height: 8,
              padding: 0,
              borderRadius: 99,
              border: 'none',
              cursor: 'pointer',
              background: i === index ? accent : i < index ? tintAccent : neutral,
              boxShadow: i < index ? `inset 0 0 0 1px ${accent}` : 'none',
            }}
          />
        ))}
      </div>
      <span style={{ fontSize: 11.5, color: muted, marginLeft: 'auto' }}>
        {index + 1} / {count}
      </span>
    </div>
  );
}

// ── lifecycle diagram (execution-model scene) ────────────────────────────────
type Stage = 'pending' | 'running' | 'suspended' | 'completed';

const STAGES: { key: Stage; label: string; color: string }[] = [
  { key: 'pending', label: 'pending', color: muted },
  { key: 'running', label: 'running', color: accent },
  { key: 'suspended', label: 'suspended', color: AMBER },
  { key: 'completed', label: 'completed', color: GREEN },
];

function LifecycleDiagram({ step, actor }: { step: Step; actor: string }) {
  const activeIdx = STAGES.findIndex((s) => s.key === step.stage);
  const railY = 168;
  const cx = (i: number) => 70 + i * 168;
  const stageColor = STAGES[activeIdx]?.color ?? accent;
  return (
    <svg viewBox="0 0 640 260" width="100%" role="img" aria-label={`Run status: ${step.stage}. ${actor}`} style={{ display: 'block' }}>
      {/* actor bubble */}
      <g className="cf-anim">
        <rect x={40} y={30} width={560} height={54} rx={12} fill={tintAccentSoft} stroke={border} />
        <circle cx={66} cy={57} r={5} fill={stageColor} className="cf-anim" />
        <text x={84} y={61} style={{ fontSize: 13, fill: ink, fontWeight: 500 }}>
          {actor}
        </text>
      </g>
      {/* connector from actor to active stage */}
      <line x1={cx(activeIdx)} y1={84} x2={cx(activeIdx)} y2={railY - 26} stroke={stageColor} strokeWidth={1.5} className="cf-anim cf-drop" strokeDasharray="4 4" />

      {/* rail */}
      <line x1={cx(0)} y1={railY} x2={cx(STAGES.length - 1)} y2={railY} stroke={border} strokeWidth={2} />
      <line x1={cx(0)} y1={railY} x2={cx(Math.max(0, activeIdx))} y2={railY} stroke={GREEN} strokeWidth={2} className="cf-anim" />

      {STAGES.map((stage, i) => {
        const done = i < activeIdx;
        const on = i === activeIdx;
        return (
          <g key={stage.key} className="cf-anim">
            {on && <circle cx={cx(i)} cy={railY} r={26} fill={stage.color} opacity={0.16} className="cf-pulse" />}
            <circle
              cx={cx(i)}
              cy={railY}
              r={on ? 15 : 11}
              className="cf-anim"
              fill={on ? stage.color : done ? tintGreen : neutral}
              stroke={on ? stage.color : done ? GREEN : border}
              strokeWidth={1.5}
            />
            {done && <path d={`M ${cx(i) - 4} ${railY} l 3 3 l 6 -7`} fill="none" stroke={GREEN} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
            <text
              x={cx(i)}
              y={railY + 40}
              textAnchor="middle"
              className="cf-anim"
              style={{ fontSize: 12.5, fill: on ? ink : muted, fontWeight: on ? 600 : 400, letterSpacing: 0.2 }}
            >
              {stage.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── dispatch diagram (dispatched-step scene) ────────────────────────────────
function DispatchDiagram({ step }: { step: Step }) {
  const p = step.stage; // defined | dispatch | running | checkpoint | replay
  const wfActive = p === 'dispatch' || p === 'checkpoint' || p === 'replay';
  const workerActive = p === 'defined' || p === 'running';
  const workerDim = p === 'replay';
  const storeLit = p === 'checkpoint' || p === 'replay';
  const flowing = p === 'dispatch' || p === 'running';
  const token = p === 'dispatch' ? { x: 320, y: 106 } : p === 'running' ? { x: 506, y: 106 } : { x: 140, y: 106 };
  const sub =
    p === 'running'
      ? { t: 'suspended · 0 compute', c: AMBER }
      : p === 'checkpoint' || p === 'replay'
        ? { t: 'resumes with result', c: GREEN }
        : { t: 'calls ctx.step', c: muted };
  const storeFill = 'color-mix(in srgb, #30a46c 13%, var(--color-fd-card))';
  return (
    <svg viewBox="0 0 640 250" width="100%" role="img" aria-label={`${step.title}: ${step.actor}`} style={{ display: 'block' }}>
      <defs>
        <marker id="cf-arrow-g" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={GREEN} />
        </marker>
        <marker id="cf-arrow-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={accent} />
        </marker>
      </defs>

      <line x1={232} y1={106} x2={408} y2={106} stroke={border} strokeWidth={2} />
      <line
        x1={232}
        y1={106}
        x2={404}
        y2={106}
        stroke={accent}
        strokeWidth={2}
        strokeDasharray="5 5"
        markerEnd="url(#cf-arrow-a)"
        className={`cf-anim ${flowing ? 'cf-flow' : ''}`}
        opacity={flowing ? 1 : 0}
      />

      {/* checkpoint-save arc (worker → store) */}
      <path d="M 500 150 C 500 196, 440 202, 392 202" fill="none" stroke={GREEN} strokeWidth={2} strokeDasharray="5 5" markerEnd="url(#cf-arrow-g)" className="cf-anim cf-flow" opacity={p === 'checkpoint' ? 1 : 0} />
      {/* replay arc (store → workflow) */}
      <path d="M 248 202 C 176 202, 138 178, 138 152" fill="none" stroke={GREEN} strokeWidth={2} strokeDasharray="5 5" markerEnd="url(#cf-arrow-g)" className="cf-anim cf-flow" opacity={p === 'replay' ? 1 : 0} />

      {/* workflow box */}
      <g className="cf-anim">
        <rect x={36} y={64} width={196} height={84} rx={12} className="cf-anim" fill={wfActive ? tintAccent : neutral} stroke={wfActive ? accent : border} strokeWidth={1.5} />
        <text x={54} y={98} style={{ fontSize: 13.5, fill: ink, fontWeight: 600 }}>
          workflow body
        </text>
        <text x={54} y={120} className="cf-anim" style={{ fontSize: 11.5, fill: sub.c }}>
          {sub.t}
        </text>
      </g>

      {/* worker box */}
      <g className="cf-anim" opacity={workerDim ? 0.42 : 1}>
        <rect x={408} y={64} width={196} height={84} rx={12} className="cf-anim" fill={workerActive ? tintAccent : neutral} stroke={workerActive ? accent : border} strokeWidth={1.5} />
        <text x={426} y={98} style={{ fontSize: 13.5, fill: ink, fontWeight: 600 }}>
          @Step handler
        </text>
        <text x={426} y={120} className="cf-anim" style={{ fontSize: 11.5, fill: muted }}>
          {p === 'running' ? 'running on a worker' : p === 'replay' ? 'not called on replay' : 'on any worker'}
        </text>
      </g>

      {/* checkpoint store */}
      <g className="cf-anim">
        <rect x={252} y={182} width={136} height={40} rx={9} className="cf-anim" fill={storeLit ? storeFill : neutral} stroke={storeLit ? GREEN : border} strokeWidth={1.5} />
        {storeLit && <path d="M 270 202 l 4 4 l 8 -9" fill="none" stroke={GREEN} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
        <text x={storeLit ? 290 : 320} y={207} textAnchor={storeLit ? 'start' : 'middle'} className="cf-anim" style={{ fontSize: 12, fill: storeLit ? ink : muted, fontWeight: 500 }}>
          checkpoint
        </text>
      </g>

      {/* token — travels the transport during dispatch/running; the arcs carry checkpoint/replay */}
      <g className="cf-token" style={{ transform: `translate(${token.x}px, ${token.y}px)`, opacity: flowing ? 1 : 0 }}>
        <circle r={13} fill={accent} opacity={0.18} className="cf-pulse" />
        <circle r={8} fill={accent} stroke="var(--color-fd-card)" strokeWidth={2} />
      </g>
    </svg>
  );
}

// ── workflow timeline (generic multi-beat walkthrough) ───────────────────────
// A reusable rail of labelled beats — one per step/sleep/signal/child in a run body.
// Each walkthrough step lights one beat (its `active` index) in a `tone` (run/wait/done);
// passed beats show a check, upcoming beats stay neutral. Scenes supply the beat labels.
function WorkflowTimeline({ beats, active, tone, actor, failed, attempts }: { beats: string[]; active: number; tone: 'run' | 'wait' | 'done' | 'fail'; actor: string; failed?: number[]; attempts?: { done: ('fail' | 'ok')[]; max: number } }) {
  const count = beats.length;
  const gap = 150;
  const x0 = 74;
  const width = x0 * 2 + (count - 1) * gap;
  const railY = 150;
  const cx = (i: number) => x0 + i * gap;
  const toneColor = tone === 'fail' ? RED : tone === 'wait' ? AMBER : tone === 'done' ? GREEN : accent;
  return (
    <svg viewBox={`0 0 ${width} 232`} width="100%" role="img" aria-label={actor} style={{ display: 'block' }}>
      <g className="cf-anim">
        <rect x={16} y={26} width={width - 32} height={48} rx={12} fill={tintAccentSoft} stroke={border} />
        <circle cx={40} cy={50} r={5} fill={toneColor} className="cf-anim" />
        <text x={58} y={54} style={{ fontSize: 13, fill: ink, fontWeight: 500 }}>
          {actor}
        </text>
      </g>
      <line x1={cx(active)} y1={74} x2={cx(active)} y2={railY - 24} stroke={toneColor} strokeWidth={1.5} strokeDasharray="4 4" className="cf-anim" />

      {/* per-attempt marks over the active beat (retry scenes): ✗ per failed attempt, ✓ on the one
          that landed, faint slots for attempts never needed — with an "attempt k/max" counter. */}
      {attempts && (() => {
        const spacing = 22;
        const rowX0 = cx(active) - ((attempts.max - 1) * spacing) / 2;
        const rowY = 96;
        return (
          <g className="cf-anim">
            {Array.from({ length: attempts.max }, (_, a) => {
              const outcome = attempts.done[a];
              const ax = rowX0 + a * spacing;
              return (
                <g key={`attempt-${a}`} className="cf-anim">
                  <circle cx={ax} cy={rowY} r={8} fill={outcome === 'fail' ? tintRed : outcome === 'ok' ? tintGreen : 'var(--color-fd-card)'} stroke={outcome === 'fail' ? RED : outcome === 'ok' ? GREEN : border} strokeWidth={1.5} />
                  {outcome === 'fail' && <path d={`M ${ax - 3} ${rowY - 3} l 6 6 M ${ax + 3} ${rowY - 3} l -6 6`} fill="none" stroke={RED} strokeWidth={1.75} strokeLinecap="round" />}
                  {outcome === 'ok' && <path d={`M ${ax - 3.5} ${rowY} l 2.5 2.5 l 5 -6`} fill="none" stroke={GREEN} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />}
                </g>
              );
            })}
            <rect x={cx(active) - 36} y={rowY + 12} width={72} height={15} rx={4} fill="var(--color-fd-card)" />
            <text x={cx(active)} y={rowY + 23} textAnchor="middle" style={{ fontSize: 10.5, fill: muted, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
              attempt {Math.min(attempts.done.length, attempts.max)}/{attempts.max}
            </text>
          </g>
        );
      })()}

      <line x1={cx(0)} y1={railY} x2={cx(count - 1)} y2={railY} stroke={border} strokeWidth={2} />
      <line x1={cx(0)} y1={railY} x2={cx(Math.max(0, active))} y2={railY} stroke={GREEN} strokeWidth={2} className="cf-anim" />

      {beats.map((label, i) => {
        const done = i < active;
        const on = i === active;
        // A passed beat is SEMANTIC, not themed: green check = it succeeded, red ✗ = it failed
        // (scenes flag those via `failed` — e.g. the saga's declined deposit stays a red ✗ while
        // the undo beats light up after it).
        const failedBeat = failed?.includes(i) ?? false;
        const doneColor = failedBeat ? RED : GREEN;
        return (
          <g key={`${label}-${i}`} className="cf-anim">
            {on && <circle cx={cx(i)} cy={railY} r={26} fill={toneColor} opacity={0.15} className="cf-pulse" />}
            <circle cx={cx(i)} cy={railY} r={on ? 15 : 11} className="cf-anim" fill={on ? toneColor : done ? (failedBeat ? tintRed : tintGreen) : neutral} stroke={on ? toneColor : done ? doneColor : border} strokeWidth={1.5} />
            {done && !failedBeat && <path d={`M ${cx(i) - 4} ${railY} l 3 3 l 6 -7`} fill="none" stroke={GREEN} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
            {done && failedBeat && <path d={`M ${cx(i) - 4} ${railY - 4} l 8 8 M ${cx(i) + 4} ${railY - 4} l -8 8`} fill="none" stroke={RED} strokeWidth={2} strokeLinecap="round" />}
            <text x={cx(i)} y={railY + 38} textAnchor="middle" className="cf-anim" style={{ fontSize: 12, fill: on ? ink : muted, fontWeight: on ? 600 : 400 }}>
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── child-workflow diagram (two lanes: parent above, child below) ────────────
// Shows a child dispatched from the parent: the spawn arrow down, the child running its
// own beats, and (for ctx.child) the return arrow back up as the parent resumes — or (for
// startChild) the parent settling while the child keeps running on its own lane.
// `parallel` renders the two lanes as INDEPENDENT runs (no spawn/return arrows, aligned starts,
// both lanes always lit) — used to contrast two runs of the same workflow, e.g. old-vs-patched code.
function ChildDiagram({ step, parentBeats, childBeats, spawnIdx, parentLabel, childLabel, pFailed, parallel = false }: { step: Step; parentBeats: string[]; childBeats: string[]; spawnIdx: number; parentLabel: string; childLabel: string; pFailed?: number[]; parallel?: boolean }) {
  const cs = step.child ?? { pActive: 0, cActive: -1 };
  const np = parentBeats.length;
  const nc = childBeats.length;
  const pY = 82;
  const cY = 190;
  const pcx = (i: number) => 190 + (i * (600 - 190)) / Math.max(1, np - 1);
  const ccx = (i: number) => (parallel ? 190 : 300) + (i * (600 - (parallel ? 190 : 300))) / Math.max(1, nc - 1);
  const pTone = cs.pTone === 'fail' ? RED : cs.pTone === 'wait' ? AMBER : cs.pTone === 'done' ? GREEN : accent;
  const childStarted = cs.cActive >= 0;
  const spawnLit = cs.arrow === 'spawn';
  const returnLit = cs.arrow === 'return';

  // Passed beats read semantically on any theme: green check = succeeded, red ✗ = failed (`isFailed`).
  function beat(x: number, y: number, on: boolean, done: boolean, color: string, label: string, labelY: number, isFailed = false) {
    const doneColor = isFailed ? RED : GREEN;
    return (
      <g className="cf-anim">
        {on && <circle cx={x} cy={y} r={24} fill={color} opacity={0.15} className="cf-pulse" />}
        <circle cx={x} cy={y} r={on ? 14 : 10} className="cf-anim" fill={on ? color : done ? (isFailed ? tintRed : tintGreen) : neutral} stroke={on ? color : done ? doneColor : border} strokeWidth={1.5} />
        {done && !isFailed && <path d={`M ${x - 4} ${y} l 3 3 l 6 -7`} fill="none" stroke={GREEN} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
        {done && isFailed && <path d={`M ${x - 3.5} ${y - 3.5} l 7 7 M ${x + 3.5} ${y - 3.5} l -7 7`} fill="none" stroke={RED} strokeWidth={2} strokeLinecap="round" />}
        <text x={x} y={labelY} textAnchor="middle" className="cf-anim" style={{ fontSize: 11.5, fill: on ? ink : muted, fontWeight: on ? 600 : 400 }}>
          {label}
        </text>
      </g>
    );
  }

  return (
    <svg viewBox="0 0 640 240" width="100%" role="img" aria-label={step.actor} style={{ display: 'block' }}>
      <defs>
        <marker id="cf-c-spawn" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill={accent} />
        </marker>
        <marker id="cf-c-return" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill={GREEN} />
        </marker>
      </defs>

      {/* parallel lanes start at x=190, so their (longer) labels ride higher to clear the beat labels */}
      <text x={16} y={parallel ? pY - 44 : pY - 26} style={{ fontSize: 12, fill: muted, fontWeight: 600 }}>
        {parentLabel}
      </text>
      <text x={16} y={parallel ? cY - 44 : cY - 26} className="cf-anim" style={{ fontSize: 12, fill: parallel || childStarted ? muted : border, fontWeight: 600 }}>
        {childLabel}
      </text>

      {/* spawn arrow (parent → child) — hidden for parallel-runs scenes */}
      {!parallel && <path d={`M ${pcx(spawnIdx)} ${pY + 16} C ${pcx(spawnIdx)} ${pY + 58}, ${ccx(0)} ${cY - 58}, ${ccx(0)} ${cY - 16}`} fill="none" stroke={spawnLit ? accent : border} strokeWidth={spawnLit ? 2 : 1.25} strokeDasharray="5 5" markerEnd={spawnLit ? 'url(#cf-c-spawn)' : undefined} className={`cf-anim ${spawnLit ? 'cf-flow' : ''}`} opacity={childStarted ? 1 : 0} />}
      {/* return arrow (child → parent) — ctx.child only */}
      {!parallel && <path d={`M ${ccx(nc - 1)} ${cY - 16} C ${ccx(nc - 1)} ${cY - 58}, ${pcx(spawnIdx + 1)} ${pY + 58}, ${pcx(spawnIdx + 1)} ${pY + 16}`} fill="none" stroke={GREEN} strokeWidth={2} strokeDasharray="5 5" markerEnd="url(#cf-c-return)" className="cf-anim cf-flow" opacity={returnLit ? 1 : 0} />}

      {/* parent rail */}
      <line x1={pcx(0)} y1={pY} x2={pcx(np - 1)} y2={pY} stroke={border} strokeWidth={2} />
      <line x1={pcx(0)} y1={pY} x2={pcx(cs.pDone ? np - 1 : Math.max(0, cs.pActive))} y2={pY} stroke={GREEN} strokeWidth={2} className="cf-anim" />
      {parentBeats.map((label, i) => beat(pcx(i), pY, !cs.pDone && i === cs.pActive, cs.pDone || i < cs.pActive, pTone, label, pY - 22, pFailed?.includes(i) ?? false))}

      {/* child rail */}
      <g className="cf-anim" opacity={parallel || childStarted ? 1 : 0.4}>
        <line x1={ccx(0)} y1={cY} x2={ccx(nc - 1)} y2={cY} stroke={border} strokeWidth={2} />
        <line x1={ccx(0)} y1={cY} x2={ccx(cs.cDone ? nc - 1 : Math.max(0, cs.cActive))} y2={cY} stroke={GREEN} strokeWidth={2} className="cf-anim" opacity={parallel || childStarted ? 1 : 0} />
        {childBeats.map((label, i) => beat(ccx(i), cY, childStarted && !cs.cDone && i === cs.cActive, cs.cDone || (childStarted && i < cs.cActive), accent, label, cY + 28))}
      </g>
    </svg>
  );
}

// ── scenes ───────────────────────────────────────────────────────────────────
type Scene = { code: string; steps: Step[]; render: (step: Step) => ReactNode; stack?: boolean };

const timeline = (beats: string[], opts?: { failed?: number[] }) => (step: Step) => <WorkflowTimeline beats={beats} active={step.active ?? 0} tone={step.tone ?? 'run'} actor={step.actor} failed={opts?.failed} attempts={step.attempts} />;

const executionModel: Scene = {
  code: `// returns at once — never blocks on the body
const { runId } = await engine.start(CheckoutWorkflow, order);

// a worker leases the pending run, runs the body:
async run(ctx: WorkflowCtx, order: Order) {
  await ctx.step(this.inventory.reserve, order);
  await ctx.waitForSignal('approve');
  await ctx.step(this.shipping.ship, order);
}

// later, from anywhere — an approval, a webhook:
await engine.signal('approve', { by: 'ops' });`,
  steps: [
    {
      lines: [1, 2],
      title: 'start enqueues',
      actor: "start → returns { runId, status: 'pending' }",
      stage: 'pending',
      caption: 'engine.start creates the run and returns immediately — the HTTP handler never blocks on workflow logic. The body is dispatched to a worker.',
    },
    {
      lines: [4, 5],
      title: 'a worker runs the body',
      actor: 'a worker leases the pending run',
      stage: 'running',
      caption: 'A worker picks up the pending run and executes the deterministic body.',
    },
    {
      lines: [6, 6],
      title: 'ctx.step',
      actor: 'step dispatched → result checkpointed',
      stage: 'running',
      caption: "ctx.step dispatches the unit to a worker and checkpoints its result — on replay it's returned, not re-run.",
    },
    {
      lines: [7, 7],
      title: 'waitForSignal',
      actor: 'run parked — worker freed, zero compute',
      stage: 'suspended',
      caption: 'waitForSignal parks the run as suspended and frees the worker — no thread is held while it waits.',
    },
    {
      lines: [12, 12],
      title: 'engine.signal',
      actor: "signal('approve') delivered from anywhere",
      stage: 'running',
      caption: 'engine.signal delivers the token from anywhere; the run resumes on a worker and replays up to where it parked.',
    },
    {
      lines: [8, 9],
      title: 'settles',
      actor: 'remaining steps run → completed',
      stage: 'completed',
      caption: 'The run finishes its remaining steps and settles as completed.',
    },
  ],
  render: (step) => <LifecycleDiagram step={step} actor={step.actor} />,
};

const dispatchedStep: Scene = {
  code: `// the step handler — runs on a worker, in any process:
@Step({ retries: 3 })
async reserve(order: Order) {
  return this.inventory.hold(order);
}

// the workflow dispatches it and awaits the result:
await ctx.step(this.inventory.reserve, order);`,
  steps: [
    {
      lines: [2, 5],
      title: '@Step handler',
      actor: 'a step handler, on any worker',
      stage: 'defined',
      caption: '@Step marks a provider method as a step handler — it runs on whatever worker serves its name, in any process or language.',
    },
    {
      lines: [8, 8],
      title: 'ctx.step dispatches',
      actor: 'dispatched over the transport by name',
      stage: 'dispatch',
      caption: "ctx.step doesn't run the handler inline — it dispatches the call over the transport, keyed by the handler's name.",
    },
    {
      lines: [8, 8],
      title: 'a worker runs it',
      actor: 'worker runs the handler — run suspends',
      stage: 'running',
      caption: 'A worker picks it up and runs the handler; the run suspends with zero compute until the result lands.',
    },
    {
      lines: [8, 8],
      title: 'result checkpointed',
      actor: 'result saved → returned to the workflow',
      stage: 'checkpoint',
      caption: 'The result is written to the store as a completed checkpoint and returned to the workflow, which resumes with it.',
    },
    {
      lines: [8, 8],
      title: 'replay returns it',
      actor: 'saved result returned — handler skipped',
      stage: 'replay',
      caption: 'On a crash or replay, the completed checkpoint is returned directly — the handler is not called again.',
    },
  ],
  render: (step) => <DispatchDiagram step={step} />,
};

const checkout: Scene = {
  stack: true,
  code: `@Workflow({ name: 'checkout', version: '1' })
export class CheckoutWorkflow {
  constructor(
    private readonly inventory: InventoryService,
    private readonly payments: PaymentsService,
    private readonly shipping: ShippingService,
    private readonly email: EmailService,
  ) {}

  async run(ctx: WorkflowCtx, order: Order) {
    const hold = await ctx.step(this.inventory.reserve, order);
    const charge = await ctx.step(this.payments.charge, { order, hold });
    await ctx.waitForSignal('packed');
    const label = await ctx.step(this.shipping.ship, order);
    await ctx.step(this.email.confirm, { order, label });
    return { chargeId: charge.id, tracking: label.tracking };
  }
}`,
  steps: [
    { lines: [11, 11], stage: '', active: 0, tone: 'run', title: 'reserve', actor: 'ctx.step → reserve inventory', caption: 'Each ctx.step dispatches a unit and checkpoints its result; the run suspends until the hold lands, then resumes with it.' },
    { lines: [12, 12], stage: '', active: 1, tone: 'run', title: 'charge', actor: 'ctx.step → charge the card', caption: 'The charge result is a durable checkpoint — saved before the next line runs, so a crash never repeats the charge.' },
    { lines: [13, 13], stage: '', active: 2, tone: 'wait', title: 'waitForSignal', actor: "parked on 'packed' — zero compute", caption: "waitForSignal suspends the run until the warehouse signals 'packed'. No worker is held while it waits." },
    { lines: [14, 14], stage: '', active: 3, tone: 'run', title: 'ship', actor: 'signal resumed the run → ship', caption: 'The signal woke the run; it ships and checkpoints the tracking label.' },
    { lines: [15, 15], stage: '', active: 4, tone: 'run', title: 'confirm', actor: 'ctx.step → email the confirmation', caption: 'A final step emails the confirmation with the label.' },
    { lines: [16, 16], stage: '', active: 5, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns and the run completes. On replay, every completed step returns its saved result — none re-run.' },
  ],
  render: timeline(['reserve', 'charge', 'packed', 'ship', 'confirm', 'done']),
};

const childWorkflow: Scene = {
  stack: true,
  code: `@Workflow({ name: 'onboard', version: '1' })
export class OnboardWorkflow {
  async run(ctx: WorkflowCtx, user: User) {
    const account = await ctx.step(this.accounts.create, user);

    // run a child workflow and await its result:
    const kyc = await ctx.child(KycWorkflow, { userId: account.id });

    await ctx.step(this.email.welcome, { user, kyc });
    return { verified: kyc.passed };
  }
}`,
  steps: [
    { lines: [4, 4], stage: '', title: 'create', actor: 'ctx.step → create the account', caption: "A normal step creates the account. The child workflow hasn't started yet.", child: { pActive: 0, cActive: -1, pTone: 'run' } },
    { lines: [7, 7], stage: '', title: 'ctx.child', actor: 'ctx.child → start KycWorkflow, parent suspends', caption: 'ctx.child starts KycWorkflow — a full durable run of its own — and suspends the parent here (zero compute).', child: { pActive: 1, cActive: 0, arrow: 'spawn', pTone: 'wait' } },
    { lines: [7, 7], stage: '', title: 'child runs', actor: 'the child runs its own steps — the parent waits', caption: 'The child runs its own steps, with its own history, retries and dashboard entry. A child that takes hours costs the suspended parent nothing.', child: { pActive: 1, cActive: 1, pTone: 'wait' } },
    { lines: [7, 7], stage: '', title: 'result returns', actor: 'child settled → its output flows back', caption: 'The child reaches a terminal state and its output flows back, resuming the parent. (A child failure would throw in the parent instead.)', child: { pActive: 1, cActive: 2, cDone: true, arrow: 'return', pTone: 'wait' } },
    { lines: [9, 9], stage: '', title: 'welcome', actor: 'parent resumed → welcome email', caption: "The parent resumes with the child's result and emails the user.", child: { pActive: 2, cActive: 2, cDone: true, pTone: 'run' } },
    { lines: [10, 10], stage: '', title: 'completes', actor: 'parent settles — completed', caption: "The parent returns the child's verified flag; the run completes.", child: { pActive: 3, cActive: 2, cDone: true, pDone: true, pTone: 'done' } },
  ],
  render: (step) => <ChildDiagram step={step} parentBeats={['create', 'ctx.child', 'welcome', 'done']} childBeats={['verify', 'score', 'done']} spawnIdx={1} parentLabel="parent · onboard" childLabel="child · KycWorkflow" />,
};

const startChild: Scene = {
  stack: true,
  code: `@Workflow({ name: 'publish-post', version: '1' })
export class PublishPostWorkflow {
  async run(ctx: WorkflowCtx, post: Post) {
    await ctx.step(this.posts.publish, post);

    // fire-and-forget — don't make publishing wait on indexing:
    await ctx.startChild(ReindexSearchWorkflow, { postId: post.id });

    return { published: true };
  }
}`,
  steps: [
    { lines: [4, 4], stage: '', title: 'publish', actor: 'ctx.step → publish the post', caption: 'A step publishes the post. Nothing has been spun off yet.', child: { pActive: 0, cActive: -1, pTone: 'run' } },
    { lines: [7, 7], stage: '', title: 'startChild', actor: "ctx.startChild → dispatch the child, don't wait", caption: 'ctx.startChild dispatches ReindexSearchWorkflow and returns its run id immediately — the parent does NOT suspend.', child: { pActive: 1, cActive: 0, arrow: 'spawn', pTone: 'run' } },
    { lines: [9, 9], stage: '', title: 'parent completes', actor: 'parent settles — the child keeps running', caption: 'The parent returns and completes right away, while the child keeps running on its own lane — an independent durable run.', child: { pActive: 2, cActive: 1, pDone: true, pTone: 'done' } },
    { lines: [9, 9], stage: '', title: 'child lives on', actor: 'the child finishes later, independently', caption: "The child finishes on its own later; a failure there never touches the already-settled parent — inspect or retry it from the dashboard.", child: { pActive: 2, cActive: 2, cDone: true, pDone: true, pTone: 'done' } },
  ],
  render: (step) => <ChildDiagram step={step} parentBeats={['publish', 'startChild', 'done']} childBeats={['reindex', 'warm', 'done']} spawnIdx={1} parentLabel="parent · publish-post" childLabel="child · ReindexSearchWorkflow" />,
};

const sleepSignals: Scene = {
  stack: true,
  code: `async run(ctx: WorkflowCtx, order: Order) {
  await ctx.step(this.orders.place, order);

  // durable timer — suspend 2h, survives restarts:
  await ctx.sleep('2h');

  // or wait for an external signal (webhook, approval):
  const approval = await ctx.waitForSignal('approved');
  await ctx.step(this.orders.finalize, { order, approval });
}`,
  steps: [
    { lines: [2, 2], stage: '', active: 0, tone: 'run', title: 'place', actor: 'ctx.step → place the order', caption: 'A step places the order and checkpoints its result.' },
    { lines: [5, 5], stage: '', active: 1, tone: 'wait', title: 'ctx.sleep', actor: 'durable timer — suspended 2h', caption: 'ctx.sleep suspends the run for 2h with zero compute; a durable timer resumes it automatically, even across restarts.' },
    { lines: [8, 8], stage: '', active: 2, tone: 'wait', title: 'waitForSignal', actor: "parked on 'approved'", caption: "waitForSignal parks the run until engine.signal('approved') arrives — buffered if it comes before the run waits, so a signal is never lost." },
    { lines: [9, 9], stage: '', active: 3, tone: 'run', title: 'finalize', actor: 'signal resumed the run → finalize', caption: 'The signal woke the run; it finalizes with the payload.' },
    { lines: [10, 10], stage: '', active: 4, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns; the run completes.' },
  ],
  render: timeline(['place', 'sleep 2h', 'approved', 'finalize', 'done']),
};

const webhook: Scene = {
  stack: true,
  code: `// checkout.workflow.ts
async run(ctx: WorkflowCtx, order: Order) {
  // mint a durable webhook: deterministic token + public callback url
  const hook = ctx.webhook<PaymentResult>();

  // hand the url to the provider INSIDE a step (checkpointed, fires once)
  await ctx.step(this.psp.startPayment, { orderId: order.id, callbackUrl: hook.url });

  // suspend with zero compute until the provider POSTs the callback
  const result = await hook.wait();

  if (result.status !== 'paid') {
    throw new FatalError(\`payment \${result.providerRef} failed\`, 'payment_failed');
  }
  await ctx.step(this.orders.fulfil, { order, providerRef: result.providerRef });
  return { orderId: order.id, providerRef: result.providerRef };
}

// hours later — the PROVIDER hits the url the run handed out:
//   POST /durable/webhooks/wh:af92:0   { "status": "paid", "providerRef": "psp_123" }
// the built-in route resolves the token and delivers the body:
//   engine.signal('wh:af92:0', { status: 'paid', providerRef: 'psp_123' })
// → the suspended run resumes at hook.wait() with that payload`,
  steps: [
    { lines: [3, 4], stage: '', active: 0, tone: 'run', title: 'mint', actor: 'ctx.webhook → deterministic token + url', caption: 'ctx.webhook() reserves a logical position now and mints a handle with a token (wh:<runId>:<seq>) and public url — both stable across replay.' },
    { lines: [6, 7], stage: '', active: 1, tone: 'run', title: 'hand url', actor: 'ctx.step → start payment with hook.url', caption: 'The url is handed to the provider inside a step, so the handoff is checkpointed and fires exactly once, even across replay/recovery.' },
    { lines: [9, 10], stage: '', active: 2, tone: 'wait', title: 'hook.wait', actor: 'suspended — zero compute until the callback', caption: 'hook.wait() parks the run on the token the mint reserved. It suspends with zero compute — no polling, no held thread — for minutes or months.' },
    { lines: [19, 23], stage: '', active: 3, tone: 'run', title: 'POST →', actor: 'the provider POSTs the callback url', caption: "This is the moment someone hits the endpoint: the provider POSTs the url it was given, and the built-in route turns that HTTP call into engine.signal(token, body) — no controller for you to write." },
    { lines: [12, 15], stage: '', active: 4, tone: 'run', title: 'resume + fulfil', actor: 'wait() resumed with the payload → fulfil', caption: 'The signal delivered the PaymentResult and wait() resumed exactly where it parked. The workflow guards the status and fulfils the order in a step.' },
    { lines: [16, 16], stage: '', active: 5, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns and the run completes. On replay, the mint, step and callback payload all return their saved values — none re-run.' },
  ],
  render: timeline(['mint', 'hand url', 'wait', 'POST →', 'fulfil', 'done']),
};

const scheduling: Scene = {
  stack: true,
  code: `@Workflow({ name: 'daily-report', version: '1' })
export class DailyReportWorkflow {
  constructor(private readonly reports: ReportService) {}
  async run(ctx: WorkflowCtx) {
    const rows = await ctx.step(this.reports.gatherYesterday, undefined);
    await ctx.step(this.reports.email, rows);
    return { rows: rows.length };
  }
}`,
  steps: [
    { lines: [5, 5], stage: '', active: 0, tone: 'run', title: 'gather', actor: 'engine started this on the cadence → gather', caption: "The engine starts this run on its schedule — nothing here calls it. The first step gathers yesterday's rows and checkpoints them, so a re-fire of the same window resumes with the saved result instead of re-gathering." },
    { lines: [6, 6], stage: '', active: 1, tone: 'run', title: 'email', actor: 'ctx.step → email the report', caption: 'A second step emails the gathered rows; its result is a durable checkpoint, so a crash mid-send never re-runs the earlier gather.' },
    { lines: [7, 7], stage: '', active: 2, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns the row count and the run completes. Next tick opens a new time-bucket window with a fresh run id; this one is done.' },
  ],
  render: timeline(['gather', 'email', 'done']),
};

const queries: Scene = {
  stack: true,
  code: `// video-encode.workflow.ts — the run publishes progress as it works
async run(ctx: WorkflowCtx, job: EncodeJob) {
  const segments = await ctx.step(this.encoder.probe, job.src);

  for (let i = 0; i < segments.length; i++) {
    await ctx.step(this.encoder.encodeSegment, segments[i]);
    // overwrite the 'progress' key each pass — only the latest survives
    await ctx.setEvent('progress', {
      pct: Math.round(((i + 1) / segments.length) * 100),
    });
  }
  return { jobId: job.id, segments: segments.length };
}

// jobs.controller.ts — an outside reader observes it, untouched
@Get(':runId/progress')
async progress(@Param('runId') runId: string) {
  // side-effect-free: does not resume, suspend, or consume a position
  return (await this.engine.getEvent(runId, 'progress')) ?? { pct: 0 };
}`,
  steps: [
    { lines: [3, 3], stage: '', active: 0, tone: 'run', title: 'probe', actor: 'ctx.step → probe the source', caption: 'A normal step probes the media and checkpoints the segment list — the run is busy, doing real work.' },
    { lines: [6, 6], stage: '', active: 1, tone: 'run', title: 'encode', actor: 'ctx.step → encode each segment', caption: 'The loop encodes one segment per step, checkpointing each result as it goes.' },
    { lines: [8, 11], stage: '', active: 2, tone: 'run', title: 'publish', actor: "ctx.setEvent('progress', …)", caption: 'Each pass overwrites the progress key from inside the run — checkpointed, replay-safe, and bounded (only the latest value survives a query).' },
    { lines: [17, 20], stage: '', active: 3, tone: 'run', title: 'read', actor: 'engine.getEvent(runId, "progress")', caption: 'From outside — a controller, a poller, another service — engine.getEvent reads the latest snapshot with zero effect on the run: it does not resume it, consume a position, or appear in its history.' },
    { lines: [13, 13], stage: '', active: 4, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns; published values live in the checkpoints, so they stay queryable even after the run completes.' },
  ],
  render: timeline(['probe', 'encode', 'publish', 'read', 'done']),
};

const updateTimeout: Scene = {
  stack: true,
  code: `// expense-approval.workflow.ts — the run parks on a decision, bounded by a deadline
async run(ctx: WorkflowCtx, expense: Expense) {
  await ctx.setEvent('status', { state: 'awaiting-approval' });

  let decision: Decision;
  try {
    // suspends with zero compute until engine.update delivers — or 7 days pass
    decision = await ctx.onUpdate('decision', { timeoutMs: 7 * DAY });
  } catch (err) {
    if (!(err instanceof SignalTimeoutError)) throw err;
    // nobody decided in time — take the default branch and fail cleanly
    await ctx.setEvent('status', { state: 'expired' });
    throw new FatalError('approval timed out', 'expired');
  }

  await ctx.step(this.ledger.reimburse, { expense, by: decision.approver });
  return { reimbursed: true };
}`,
  steps: [
    { lines: [3, 3], stage: '', active: 0, tone: 'run', title: 'awaiting', actor: "ctx.setEvent('status', 'awaiting-approval')", caption: 'The run publishes its status and heads for the decision point.' },
    { lines: [8, 8], stage: '', active: 1, tone: 'wait', title: 'onUpdate', actor: "ctx.onUpdate('decision', { timeoutMs: 7 days })", caption: 'The run suspends here with zero compute, waiting for an external decision — with a 7-day deadline on the wait.' },
    { lines: [8, 9], stage: '', active: 2, tone: 'fail', title: '7d timeout', actor: 'no update arrives — SignalTimeoutError', caption: 'The deadline passes with nobody deciding, so the onUpdate call throws SignalTimeoutError instead of hanging forever.' },
    { lines: [11, 13], stage: '', active: 3, tone: 'fail', title: 'expired', actor: 'catch → default branch, run fails cleanly', caption: 'The workflow catches the timeout, marks the status expired, and fails deliberately — a bounded wait turns an abandoned approval into a clean terminal outcome, not a stuck run.' },
  ],
  render: timeline(['awaiting', 'onUpdate', '7d timeout', 'expired'], { failed: [2] }),
};

const updateHappy: Scene = {
  stack: true,
  code: `// expense-approval.workflow.ts — same run, but a decision arrives in time
async run(ctx: WorkflowCtx, expense: Expense) {
  await ctx.setEvent('status', { state: 'awaiting-approval' });
  // suspended here — zero compute — until engine.update delivers a decision
  const decision = await ctx.onUpdate('decision', { timeoutMs: 7 * DAY });

  await ctx.step(this.ledger.reimburse, { expense, by: decision.approver });
  return { reimbursed: true };
}

// expenses.controller.ts — the outside command that resumes the run
@Post(':runId/decision')
async decide(@Param('runId') runId: string, @Body() body: DecisionDto) {
  // the validator runs first, in THIS request — a bad decision is rejected here
  const result = await this.engine.update(runId, 'decision', body);
  if (!result.accepted) throw new BadRequestException(result.reason);
  return { status: result.run?.status ?? 'pending' };
}`,
  steps: [
    { lines: [3, 3], stage: '', active: 0, tone: 'run', title: 'awaiting', actor: "ctx.setEvent('status', 'awaiting-approval')", caption: 'Same run, same status — it reaches the decision point and parks.' },
    { lines: [5, 5], stage: '', active: 1, tone: 'wait', title: 'onUpdate', actor: "ctx.onUpdate('decision') — suspended", caption: 'The run suspends with zero compute, holding its place until an external command arrives.' },
    { lines: [15, 15], stage: '', active: 2, tone: 'run', title: 'update →', actor: "engine.update(runId, 'decision', body)", caption: 'A separate request — the controller — calls engine.update with the decision. This is the command that steers the parked run.' },
    { lines: [14, 14], stage: '', active: 3, tone: 'run', title: 'validate', actor: 'validator runs in the caller’s request', caption: 'Before the run is touched, the registered validator runs synchronously in this request. A bad decision returns { accepted: false, reason } here — the run never wakes for it.' },
    { lines: [5, 5], stage: '', active: 4, tone: 'run', title: 'resume', actor: 'accepted → delivered to onUpdate, run resumes', caption: 'Accepted: the decision is delivered to the suspended ctx.onUpdate and the run comes back to life exactly where it left off.' },
    { lines: [7, 7], stage: '', active: 5, tone: 'run', title: 'reimburse', actor: 'ctx.step → reimburse the expense', caption: 'The resumed body runs the next durable step with the delivered decision.' },
    { lines: [8, 8], stage: '', active: 6, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns and the run completes — the outside command carried it down the happy path.' },
  ],
  render: timeline(['awaiting', 'onUpdate', 'update →', 'validate', 'resume', 'reimburse', 'done']),
};

const deadLetter: Scene = {
  stack: true,
  code: `// pipeline.workflow.ts — a poison-pill run, and the handler that catches it
@Workflow({ name: 'pipeline', version: '3' })
export class PipelineWorkflow {
  async run(ctx: WorkflowCtx, input: PipelineInput) {
    const extracted = await ctx.step('pipeline.extract', input);
    // a deserialization bug here throws on every recovery — a poison pill
    return ctx.step('pipeline.transform', extracted);
  }

  // Auto-registered as 'pipeline.dlq' — a durable workflow of its own
  @DeadLetter()
  async onDead(ctx: WorkflowCtx, dl: DeadLetter<PipelineInput>) {
    await ctx.step(this.alerts.page, { runId: dl.deadRunId, error: dl.error?.message });
    const ticket = await ctx.step(this.tickets.create, { payload: dl.input });
    return { ticketId: ticket.id };
  }
}`,
  steps: [
    { lines: [5, 5], stage: '', title: 'extract', actor: 'ctx.step → extract', caption: "The run's first step succeeds and checkpoints — nothing looks wrong yet.", child: { pActive: 0, cActive: -1, pTone: 'run' } },
    { lines: [7, 7], stage: '', title: 'transform', actor: 'ctx.step → transform (throws)', caption: 'The transform step is the poison pill: a deserialization bug makes it throw the moment it runs.', child: { pActive: 1, cActive: -1, pTone: 'run' } },
    { lines: [6, 7], stage: '', title: 'crash ×5', actor: 'crash-recovery resumes it → it throws again', caption: 'Crash-recovery reclaims the orphaned run and resumes it — it throws again, and again. Each pickup increments recoveryAttempts toward maxRecoveryAttempts.', child: { pActive: 2, cActive: -1, pTone: 'fail' } },
    { lines: [7, 7], stage: '', title: 'dead', actor: 'past the cap → status: dead', caption: "Past maxRecoveryAttempts the engine stops resuming it: the run moves to the terminal 'dead' status and releases its lease. The crash loop is broken — one poison pill no longer takes the instance down.", child: { pActive: 3, cActive: -1, pTone: 'fail' } },
    { lines: [11, 13], stage: '', title: 'DLQ: page', actor: '@DeadLetter handler starts as its own run', caption: 'Dead-lettering starts the @DeadLetter method as a separate durable run (pipeline.dlq), idempotent by dlq:<runId> — the dead run stays parked where it is. The handler’s first step pages on-call.', child: { pActive: 3, cActive: 0, arrow: 'spawn', pTone: 'fail' } },
    { lines: [14, 14], stage: '', title: 'ticket', actor: 'ctx.step → open a ticket with the original input', caption: 'A second step opens a ticket carrying the dead run’s original typed input — ready to replay once the bug is fixed.', child: { pActive: 3, cActive: 1, pTone: 'fail' } },
    { lines: [15, 15], stage: '', title: 'handled', actor: 'DLQ run settles — completed', caption: 'The DLQ run completes on its own lane. The poison pill stays dead — inspectable and retriable from the dashboard — handled, not lost.', child: { pActive: 3, cActive: 2, cDone: true, pTone: 'fail' } },
  ],
  render: (step) => <ChildDiagram step={step} parentBeats={['extract', 'transform', 'crash ×5', 'dead']} childBeats={['page', 'ticket', 'done']} spawnIdx={3} parentLabel="run · pipeline" childLabel="DLQ · pipeline.dlq" pFailed={[1, 2]} />,
};

const versioning: Scene = {
  stack: true,
  code: `@Workflow({ name: 'checkout', version: '1' })
export class CheckoutWorkflow {
  async run(ctx: WorkflowCtx, order: Order) {
    const quote = await ctx.step(this.pricing.quote, order);

    if (await ctx.patched('add-fraud-check')) {
      // NEW branch — only runs that started after this shipped enter here
      const risk = await ctx.step(this.fraud.score, { orderId: order.id });
      if (risk.score > 0.9) throw new FatalError('high fraud risk', 'fraud');
    }

    await ctx.step(this.payments.charge, { orderId: order.id, amountCents: quote.total });
  }
}`,
  steps: [
    { lines: [4, 4], stage: '', title: 'quote', actor: 'both runs price the order — same prefix', caption: 'Two runs of the SAME workflow execute side by side: run A was in flight when the patch shipped; run B started after. The unchanged prefix is identical — both checkpoint the quote at position 0.', child: { pActive: 0, cActive: 0, pTone: 'run' } },
    { lines: [6, 6], stage: '', title: 'patched gate', actor: "ctx.patched('add-fraud-check') — the fork", caption: "This one line forks by the code each run STARTED on: run A's history already holds a real step at this position → false; run B records a patch:add-fraud-check marker → true. The version stays pinned to what each run began under.", child: { pActive: 1, cActive: 1, pTone: 'run' } },
    { lines: [7, 9], stage: '', title: 'new path', actor: 'only run B enters the fraud check', caption: 'Run B takes the new branch and scores fraud. Run A skips it entirely — the marker rewinds the logical position rather than consuming it, so its recorded checkpoints never shift.', child: { pActive: 2, cActive: 2, pTone: 'run' } },
    { lines: [12, 12], stage: '', title: 'charge', actor: 'both runs converge on the charge', caption: 'Both paths converge on the same charge call — at each run’s own position in its own history — so old and new runs charge deterministically. The guard changed the branch, not the surrounding sequence.', child: { pActive: 2, cActive: 3, pTone: 'run' } },
    { lines: [13, 14], stage: '', title: 'completes', actor: 'both settle — neither replay corrupted', caption: 'Run A finishes on the old path, run B on the new — one codebase, two safe histories. Without the guard, run A would have hit a NonDeterminismError the moment the fraud step shifted its positions.', child: { pActive: 3, cActive: 4, pDone: true, cDone: true, pTone: 'done' } },
  ],
  render: (step) => <ChildDiagram step={step} parentBeats={['quote', 'gate→false', 'charge', 'done']} childBeats={['quote', 'gate→true', 'fraud', 'charge', 'done']} spawnIdx={0} parentLabel="run A · started on the OLD code" childLabel="run B · started AFTER the patch" parallel />,
};

const retries: Scene = {
  stack: true,
  code: `@Injectable()
export class PaymentsService {
  @Step({ retries: 3, backoff: 'exp', backoffMs: 500, jitter: true })
  async chargeCard(order: Order): Promise<Charge> {
    return this.stripe.charge(order); // a transient 502 just throws — the engine retries
  }
}

@Workflow({ name: 'checkout', version: '1' })
export class CheckoutWorkflow {
  async run(ctx: WorkflowCtx, order: Order) {
    const quote = await ctx.step(this.pricing.fetchQuote, order);
    const charge = await ctx.step(this.payments.chargeCard, order);
    await ctx.step(this.email.confirm, { order, charge }, { retries: 5 });
    return charge.id;
  }
}`,
  steps: [
    { lines: [12, 12], stage: '', active: 0, tone: 'run', title: 'fetch quote', actor: 'ctx.step → fetch the quote', caption: "ctx.step dispatches fetchQuote and checkpoints its result; the handler's declared @Step retry policy applies wherever it's called." },
    { lines: [3, 3], stage: '', active: 1, tone: 'run', title: 'retry policy', actor: '@Step declares retries: 3, exp backoff, jitter', caption: 'The charge handler declares its own durable retry policy — up to 3 attempts, exponential backoff from 500ms, jittered.' },
    { lines: [13, 13], stage: '', active: 1, tone: 'fail', title: 'attempt 1 ✗', actor: 'attempt 1/3 throws — failure checkpointed', attempts: { done: ['fail'], max: 3 }, caption: 'Stripe returns a transient 502 and chargeCard throws. The engine records the failed attempt on the checkpoint — that is attempt 1 of the 3 the policy allows.' },
    { lines: [3, 3], stage: '', active: 1, tone: 'wait', title: 'backoff', actor: 'backoff ≈ 500ms × 2ⁿ + jitter — run suspended', attempts: { done: ['fail'], max: 3 }, caption: 'The retry deadline is stamped on the checkpoint as wakeAt and the run SUSPENDS durably — zero compute held while the backoff elapses, and the pending retry survives a crash or deploy.' },
    { lines: [13, 13], stage: '', active: 1, tone: 'run', title: 'attempt 2 ✓', actor: 're-dispatched → attempt 2/3 succeeds', attempts: { done: ['fail', 'ok'], max: 3 }, caption: 'The timer poller re-dispatches the step when the backoff elapses; attempt 2 succeeds and its result checkpoints — the third attempt is never needed.' },
    { lines: [14, 14], stage: '', active: 2, tone: 'run', title: 'confirm', actor: 'ctx.step → confirm, { retries: 5 } per-call', caption: 'A per-call { retries: 5 } overrides the handler default field-by-field for just this call site.' },
    { lines: [15, 17], stage: '', active: 3, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns and the run completes. On replay every completed step returns its saved result — the charge never re-runs.' },
  ],
  render: timeline(['quote', 'charge', 'confirm', 'done']),
};

const transportDispatch: Scene = {
  stack: true,
  code: `@Workflow({ name: 'process-doc', version: '1' })
export class ProcessDocumentWorkflow {
  constructor(
    private readonly intake: IntakeService,
    private readonly render: RenderService,
  ) {}

  async run(ctx: WorkflowCtx, doc: Document) {
    const clean = await ctx.step(this.intake.validate, doc);
    const pdf = await ctx.step(this.render.toPdf, clean);
    const summary = await ctx.step<Summary>('python.enrich', pdf);
    return { pdf, summary };
  }
}`,
  steps: [
    { lines: [9, 9], stage: '', active: 0, tone: 'run', title: 'validate', actor: 'ctx.step → validate (same NestJS app)', caption: 'The in-process event-emitter transport dispatches this to a @Step handler in the SAME process — no network hop.' },
    { lines: [10, 10], stage: '', active: 1, tone: 'run', title: 'render', actor: 'ctx.step → render to PDF (separate worker)', caption: 'Identical ctx.step call — but this transport carries the dispatch to a different worker process over Redis/SQS. The workflow code never changes.' },
    { lines: [11, 11], stage: '', active: 2, tone: 'run', title: 'python enrich', actor: "ctx.step<Summary>('python.enrich', pdf) → Python worker", caption: 'By-name dispatch reaches a Python worker registered under that name — same wire-level RemoteTask/StepResult, any language on the other end.' },
    { lines: [12, 13], stage: '', active: 3, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The engine checkpointed every result as it landed, regardless of which process ran the step — replay never re-dispatches a settled one.' },
  ],
  render: timeline(['validate', 'render', 'python', 'done']),
};

const saga: Scene = {
  stack: true,
  code: `// book-trip.workflow.ts — each ctx.step names its own undo
@Workflow({ name: 'book-trip', version: '1' })
export class BookTripWorkflow {
  constructor(private readonly trips: TripService) {}

  async run(ctx: WorkflowCtx, trip: TripRequest) {
    const flight = await ctx.step(this.trips.bookFlight, trip, {
      compensate: this.trips.cancelFlight,
    });
    const hotel = await ctx.step(this.trips.bookHotel, trip, {
      compensate: this.trips.cancelHotel,
    });
    // the deposit registers no compensate — nothing of its own to undo
    await ctx.step(this.trips.chargeDeposit, { trip, flight, hotel });
    return { flight, hotel };
  }
}

// trip.service.ts — an undo is an ordinary @Step, typed with UndoOf
@Step()
async cancelFlight({ output }: UndoOf<TripService['bookFlight']>) {
  await this.flightsApi.cancel(output.bookingId);
}`,
  steps: [
    { lines: [7, 9], stage: '', active: 0, tone: 'run', title: 'flight', actor: 'ctx.step → book flight, undo registered', caption: "The flight books on whatever worker serves bookFlight. Because the call completed, its compensate — cancelFlight, another @Step — is registered on the saga stack together with this call's { input, output }." },
    { lines: [10, 12], stage: '', active: 1, tone: 'run', title: 'hotel', actor: 'ctx.step → book hotel, undo registered', caption: "The hotel books and registers its own undo — pushed after the flight's, so it will be undone first." },
    { lines: [14, 15], stage: '', active: 2, tone: 'fail', title: 'deposit ✗', actor: 'ctx.step → charge deposit (fails)', caption: 'The deposit charge exhausts its retries and the run fails. It registered no undo of its own — but two earlier steps did.' },
    { lines: [11, 11], stage: '', active: 3, tone: 'run', title: 'undo hotel', actor: 'engine dispatches cancelHotel — checkpoint −1', caption: 'The engine walks the stack in reverse and DISPATCHES cancelHotel to its worker like any durable step, checkpointed at reserved seq −1 — a crash mid-unwind resumes here instead of re-running finished undos.' },
    { lines: [21, 24], stage: '', active: 4, tone: 'run', title: 'undo flight', actor: 'cancelFlight({ input, output }) — checkpoint −2', caption: "Then the flight's undo runs. An undo handler is an ordinary @Step called with the compensated call's { input, output } envelope — UndoOf<TripService['bookFlight']> types it for free, and a Python worker can serve it by name." },
    { lines: [14, 15], stage: '', active: 5, tone: 'fail', title: 'failed', actor: 'unwind done → run settles failed (original error)', caption: 'Both legs undone, the run settles failed with the ORIGINAL deposit error — never masked by the unwind. The compensate:* checkpoints keep the whole undo trail visible in the dashboard.' },
  ],
  render: timeline(['flight', 'hotel', 'deposit ✗', 'undo hotel', 'undo flight', 'failed'], { failed: [2] }),
};

const flowControl: Scene = {
  stack: true,
  code: `@Workflow({ name: 'send-receipt', version: '1' })
export class SendReceiptWorkflow {
  constructor(private readonly notify: NotificationsWorker) {}

  async run(ctx: WorkflowCtx, job: EmailJob) {
    const sent = await ctx.step(this.notify.sendEmail, job, {
      queue: 'emails',
      priority: job.urgent ? 10 : 0,
      fairnessKey: job.tenantId,
    });
    return { messageId: sent.messageId };
  }
}`,
  steps: [
    { lines: [6, 10], stage: '', active: 0, tone: 'run', title: 'dispatch', actor: "ctx.step → dispatch through the 'emails' queue", caption: "The call names the emails queue and carries priority + fairnessKey — the engine asks the queue's admission controller for a slot before dispatching." },
    { lines: [6, 10], stage: '', active: 1, tone: 'wait', title: 'blocked', actor: 'queue at its concurrency cap — call blocked', caption: 'The queue is full, so admission is blocked. The engine does NOT dispatch — it re-suspends the run with the retry time as wakeAt, and the timer poller retries later. Zero compute held.' },
    { lines: [7, 8], stage: '', active: 2, tone: 'wait', title: 'priority', actor: 'priority: 10 — this urgent job jumps the line', caption: 'When a slot frees, admission goes to the rightful next waiter: higher priority wins first, so this urgent call is admitted ahead of already-waiting lower-priority calls.' },
    { lines: [9, 9], stage: '', active: 3, tone: 'wait', title: 'fair share', actor: 'fairnessKey round-robins by tenant', caption: "Within the same priority tier, fairness breaks the tie: with the queue's fairness: 'key' set, the least-recently-served fairnessKey (e.g. this tenant) is admitted next, so one busy tenant can't starve the others." },
    { lines: [6, 11], stage: '', active: 4, tone: 'done', title: 'admitted', actor: 'slot granted → step dispatches → email sent', caption: 'Once admitted, the slot is held until the result lands; the step dispatches, sends the email, and the run completes.' },
  ],
  render: timeline(['dispatch', 'blocked', 'priority', 'fair', 'done']),
};

const SCENES: Record<string, Scene> = {
  'execution-model': executionModel,
  'dispatched-step': dispatchedStep,
  checkout,
  'child-workflow': childWorkflow,
  'start-child': startChild,
  'sleep-signals': sleepSignals,
  webhook,
  scheduling,
  queries,
  'update-timeout': updateTimeout,
  'update-happy': updateHappy,
  'dead-letter': deadLetter,
  'transport-dispatch': transportDispatch,
  saga,
  'flow-control': flowControl,
  versioning,
  retries,
};

// ── shell ────────────────────────────────────────────────────────────────────
export function CodeFlow({ scene }: { scene: string }) {
  const data = SCENES[scene];
  const svgWrap = useRef<HTMLDivElement>(null);
  const stepper = useStepper(data ? data.steps.length : 1);
  if (!data) return null;
  const step = data.steps[stepper.index];

  function jump(line: number) {
    const target = data.steps.findIndex((s) => line >= s.lines[0] && line <= s.lines[1]);
    if (target >= 0) stepper.go(target);
  }

  return (
    <figure className="my-6 rounded-2xl border border-fd-border p-3 sm:p-4" style={{ background: tintAccentSoft }}>
      <style>{`
        .cf-anim { transition: background .45s ease, box-shadow .45s ease, opacity .45s ease, fill .45s ease, stroke .45s ease, r .45s ease, width .35s ease, color .45s ease, cx .55s ease, x1 .55s ease, x2 .55s ease; }
        .cf-pulse { animation: cf-pulse 1.8s ease-out infinite; transform-box: fill-box; transform-origin: center; }
        @keyframes cf-pulse { 0% { transform: scale(.7); opacity: .3 } 70%, 100% { transform: scale(1.25); opacity: 0 } }
        .cf-token { transition: transform .6s cubic-bezier(.4,0,.2,1), opacity .4s ease; }
        .cf-flow { animation: cf-flow .6s linear infinite; }
        @keyframes cf-flow { to { stroke-dashoffset: -20 } }
        @media (prefers-reduced-motion: reduce) { .cf-anim, .cf-token { transition: none } .cf-pulse, .cf-flow { animation: none } .cf-pulse { opacity: 0 } }
      `}</style>

      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'minmax(0, 1fr)' }} className={`cf-grid ${data.stack ? 'cf-stack' : ''}`}>
        <CodePanel code={data.code} active={step.lines} onJump={jump} />
        <div ref={svgWrap} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', background: stepBg, border: `1px solid ${border}`, borderRadius: 12, padding: '10px 12px' }}>
          {data.render(step)}
        </div>
      </div>

      <div
        className="cf-anim"
        style={{
          margin: '12px 0',
          padding: '11px 14px',
          background: 'var(--color-fd-card)',
          border: `1px solid ${border}`,
          borderRadius: 10,
          fontSize: 13,
          lineHeight: 1.5,
          color: ink,
          minHeight: 44,
        }}
      >
        <span style={{ color: accent, fontWeight: 600, marginRight: 8 }}>{step.title}</span>
        {step.caption}
      </div>

      <ControlBar index={stepper.index} count={data.steps.length} playing={stepper.playing} onToggle={stepper.toggle} onGo={stepper.go} />

      <style>{`@media (min-width: 720px) { .cf-grid:not(.cf-stack) { grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr) !important; } }`}</style>
    </figure>
  );
}
