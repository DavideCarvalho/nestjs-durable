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

const tintAccent = 'color-mix(in srgb, var(--color-fd-primary) 14%, var(--color-fd-card))';
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
  tone?: 'run' | 'wait' | 'done'; // timeline scenes: the active beat's colour
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
      <line x1={cx(0)} y1={railY} x2={cx(Math.max(0, activeIdx))} y2={railY} stroke={accent} strokeWidth={2} className="cf-anim" />

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
              fill={on ? stage.color : done ? tintAccent : neutral}
              stroke={on || done ? stage.color : border}
              strokeWidth={1.5}
            />
            {done && <path d={`M ${cx(i) - 4} ${railY} l 3 3 l 6 -7`} fill="none" stroke={accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
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
function WorkflowTimeline({ beats, active, tone, actor }: { beats: string[]; active: number; tone: 'run' | 'wait' | 'done'; actor: string }) {
  const count = beats.length;
  const gap = 150;
  const x0 = 74;
  const width = x0 * 2 + (count - 1) * gap;
  const railY = 150;
  const cx = (i: number) => x0 + i * gap;
  const toneColor = tone === 'wait' ? AMBER : tone === 'done' ? GREEN : accent;
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

      <line x1={cx(0)} y1={railY} x2={cx(count - 1)} y2={railY} stroke={border} strokeWidth={2} />
      <line x1={cx(0)} y1={railY} x2={cx(Math.max(0, active))} y2={railY} stroke={accent} strokeWidth={2} className="cf-anim" />

      {beats.map((label, i) => {
        const done = i < active;
        const on = i === active;
        return (
          <g key={`${label}-${i}`} className="cf-anim">
            {on && <circle cx={cx(i)} cy={railY} r={26} fill={toneColor} opacity={0.15} className="cf-pulse" />}
            <circle cx={cx(i)} cy={railY} r={on ? 15 : 11} className="cf-anim" fill={on ? toneColor : done ? tintAccent : neutral} stroke={on ? toneColor : done ? accent : border} strokeWidth={1.5} />
            {done && <path d={`M ${cx(i) - 4} ${railY} l 3 3 l 6 -7`} fill="none" stroke={accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
            <text x={cx(i)} y={railY + 38} textAnchor="middle" className="cf-anim" style={{ fontSize: 12, fill: on ? ink : muted, fontWeight: on ? 600 : 400 }}>
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── scenes ───────────────────────────────────────────────────────────────────
type Scene = { code: string; steps: Step[]; render: (step: Step) => ReactNode; stack?: boolean };

const timeline = (beats: string[]) => (step: Step) => <WorkflowTimeline beats={beats} active={step.active ?? 0} tone={step.tone ?? 'run'} actor={step.actor} />;

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
    { lines: [4, 4], stage: '', active: 0, tone: 'run', title: 'create account', actor: 'ctx.step → create the account', caption: 'A normal step creates the account and checkpoints its result.' },
    { lines: [7, 7], stage: '', active: 1, tone: 'wait', title: 'ctx.child', actor: 'child KycWorkflow — suspended until it settles', caption: 'ctx.child starts KycWorkflow and suspends — zero compute — until the child reaches a terminal state, then resumes with its output. The childId is deterministic, so the child runs exactly once across replay.' },
    { lines: [9, 9], stage: '', active: 2, tone: 'run', title: 'welcome', actor: 'ctx.step → welcome email', caption: "The parent resumed with the child's result and emails the user." },
    { lines: [10, 10], stage: '', active: 3, tone: 'done', title: 'completes', actor: 'onboard settles — completed', caption: "The parent returns the child's verified flag; the run completes." },
  ],
  render: timeline(['create', 'KYC child', 'welcome', 'done']),
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
  code: `async run(ctx: WorkflowCtx, order: Order) {
  // mint a durable webhook: deterministic token + public callback url
  const hook = ctx.webhook<PaymentResult>();

  // hand the url to the provider INSIDE a step (checkpointed, fires once)
  await ctx.step(this.psp.startPayment, {
    orderId: order.id,
    callbackUrl: hook.url,
  });

  // suspend with zero compute until the provider POSTs the callback
  const result = await hook.wait();

  if (result.status !== 'paid') {
    throw new FatalError(\`payment \${result.providerRef} failed\`, 'payment_failed');
  }
  await ctx.step(this.orders.fulfil, { order, providerRef: result.providerRef });

  return { orderId: order.id, providerRef: result.providerRef };
}`,
  steps: [
    { lines: [3, 3], stage: '', active: 0, tone: 'run', title: 'mint', actor: 'ctx.webhook → deterministic token + url', caption: 'ctx.webhook() reserves a logical position now and mints a handle with a token (wh:<runId>:<seq>) and public url — both stable across replay.' },
    { lines: [6, 9], stage: '', active: 1, tone: 'run', title: 'hand url', actor: 'ctx.step → start payment with hook.url', caption: 'The url is handed to the provider inside a step, so the handoff is checkpointed and fires exactly once, even across replay/recovery.' },
    { lines: [12, 12], stage: '', active: 2, tone: 'wait', title: 'hook.wait', actor: 'suspended — zero compute until the callback', caption: 'hook.wait() parks the run on the token the mint reserved. It suspends with zero compute — no polling, no held thread — until the provider POSTs back as engine.signal(token, body).' },
    { lines: [14, 17], stage: '', active: 3, tone: 'run', title: 'fulfil', actor: 'callback resumed the run → fulfil', caption: 'The callback delivered the PaymentResult; wait() resumed with it. The workflow guards the status and fulfils the order in a step.' },
    { lines: [19, 19], stage: '', active: 4, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns and the run completes. On replay, the mint, step and callback payload all return their saved values — none re-run.' },
  ],
  render: timeline(['mint', 'hand url', 'callback', 'fulfil', 'done']),
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
  code: `async run(ctx: WorkflowCtx, job: EncodeJob) {
  await ctx.setEvent('progress', { phase: 'probing', pct: 0 });
  const segments = await ctx.step(this.encoder.probe, job.src);

  // an operator can raise priority mid-run — validated, or times out:
  let priority = job.priority;
  try {
    priority = await ctx.onUpdate('reprioritize', { timeoutMs: 30_000 });
  } catch (err) {
    if (!(err instanceof SignalTimeoutError)) throw err;
  }

  for (let i = 0; i < segments.length; i++) {
    await ctx.step(this.encoder.encodeSegment, { segment: segments[i], priority });
    // readers poll engine.getEvent(runId, 'progress') for the latest snapshot:
    await ctx.setEvent('progress', {
      phase: 'encoding',
      pct: Math.round(((i + 1) / segments.length) * 100),
    });
  }

  await ctx.setEvent('progress', { phase: 'done', pct: 100 });
  return { jobId: job.id, segments: segments.length };
}`,
  steps: [
    { lines: [2, 2], stage: '', active: 0, tone: 'run', title: 'publish', actor: 'ctx.setEvent → progress 0%', caption: 'ctx.setEvent publishes a named, queryable snapshot from inside the run; an outside reader observes it via engine.getEvent with no effect on the run.' },
    { lines: [3, 3], stage: '', active: 1, tone: 'run', title: 'probe', actor: 'ctx.step → probe the source', caption: 'A normal step probes the media and checkpoints the segment list.' },
    { lines: [8, 8], stage: '', active: 2, tone: 'wait', title: 'onUpdate', actor: 'external update bumps priority mid-run', caption: "ctx.onUpdate suspends with zero compute until engine.update(runId, 'reprioritize', arg) delivers a validated priority — or the 30s timeout throws SignalTimeoutError and the default priority stands." },
    { lines: [14, 14], stage: '', active: 3, tone: 'run', title: 'encode', actor: 'ctx.step → encode each segment', caption: 'The loop encodes one segment per step at the (possibly updated) priority, checkpointing each result.' },
    { lines: [16, 19], stage: '', active: 4, tone: 'run', title: 'read', actor: 'a client reads progress via engine.getEvent', caption: 'Each pass overwrites the progress key with the latest pct; a polling client reads that snapshot with engine.getEvent while the loop keeps running.' },
    { lines: [22, 23], stage: '', active: 5, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'A final setEvent marks 100% and the body returns; published values stay queryable even after the run completes.' },
  ],
  render: timeline(['publish', 'probe', 'priority', 'encode', 'read', 'done']),
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
    { lines: [4, 4], stage: '', active: 0, tone: 'run', title: 'quote', actor: 'ctx.step → price the order', caption: 'The unchanged prefix runs identically for every run: ctx.step prices the order and checkpoints the quote at this position.' },
    { lines: [6, 6], stage: '', active: 1, tone: 'run', title: 'patched gate', actor: "ctx.patched('add-fraud-check') — old vs new", caption: 'This one line forks by the code the run started on: a fresh run records a patch:add-fraud-check marker and returns true; an in-flight run, whose history already holds a real step at this position, returns false — the version stays pinned to what the run began under.' },
    { lines: [7, 9], stage: '', active: 2, tone: 'run', title: 'new path', actor: 'true → fresh runs take the fraud check', caption: 'Runs that started after the patch shipped enter the new branch and score fraud. In-flight runs got false and skip it — the marker rewinds the logical position rather than consuming it, so their recorded checkpoints never shift.' },
    { lines: [12, 12], stage: '', active: 3, tone: 'run', title: 'charge', actor: 'ctx.step → charge the card', caption: 'Both paths converge here on the same checkpoint position, so old and new runs charge deterministically — the guard changed the branch, not the surrounding sequence.' },
    { lines: [13, 14], stage: '', active: 4, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns and the run completes. New runs finish on the new path, old runs finish on the old — neither replay is corrupted.' },
  ],
  render: timeline(['quote', 'patched?', 'fraud check', 'charge', 'done']),
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
    { lines: [13, 13], stage: '', active: 1, tone: 'run', title: 'charge (retries)', actor: 'attempt fails → re-dispatched → succeeds', caption: 'fails transiently → the engine re-dispatches per the retry policy → succeeds. The run suspends durably between attempts, so no worker is held.' },
    { lines: [14, 14], stage: '', active: 2, tone: 'run', title: 'confirm', actor: 'ctx.step → confirm, { retries: 5 } per-call', caption: 'A per-call { retries: 5 } overrides the handler default field-by-field for just this call site.' },
    { lines: [15, 17], stage: '', active: 3, tone: 'done', title: 'completes', actor: 'run settles — completed', caption: 'The body returns and the run completes. On replay every completed step returns its saved result — the charge never re-runs.' },
  ],
  render: timeline(['quote', 'charge', 'confirm', 'done']),
};

const SCENES: Record<string, Scene> = {
  'execution-model': executionModel,
  'dispatched-step': dispatchedStep,
  checkout,
  'child-workflow': childWorkflow,
  'sleep-signals': sleepSignals,
  webhook,
  scheduling,
  queries,
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
