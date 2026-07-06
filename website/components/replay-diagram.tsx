// Checkpoint-and-replay illustration for the durability docs. Hand-authored SVG (no runtime deps),
// theme-aware via Fumadocs' `--color-fd-*` CSS variables. Reads top-to-bottom as time: the first
// run executes each step and writes its checkpoint down into the store; after a crash, replay reads
// completed checkpoints back up (returning the saved output without re-running) and executes only
// the step that has none.

const ink = 'var(--color-fd-foreground)';
const muted = 'var(--color-fd-muted-foreground)';
const card = 'var(--color-fd-card)';
const border = 'var(--color-fd-border)';
const accent = 'var(--color-fd-primary)';
const accentSoft = 'color-mix(in srgb, var(--color-fd-primary) 14%, transparent)';
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// Column centers, one per step. Every band lines its cells up on these.
const COLS = [200, 410, 620];
const CELL_W = 156;
const SLOT_W = 150;

/** A step cell in the first-run or replay band. `variant` sets the visual weight. */
function Cell({
  cx,
  y,
  h,
  variant,
  title,
  sub,
}: {
  cx: number;
  y: number;
  h: number;
  variant: 'exec' | 'saved' | 'crash';
  title: string;
  sub: string;
}) {
  const x = cx - CELL_W / 2;
  const executed = variant === 'exec';
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={CELL_W}
        height={h}
        rx={10}
        style={{
          fill: card,
          stroke: executed ? accent : border,
          strokeWidth: executed ? 1.5 : 1,
          strokeDasharray: variant === 'exec' ? undefined : '4 3',
        }}
        filter="url(#rsoft)"
      />
      {executed ? <rect x={x} y={y} width={4} height={h} rx={2} style={{ fill: accent }} /> : null}
      <text
        x={cx}
        y={y + 26}
        textAnchor="middle"
        style={{ fill: variant === 'saved' ? muted : ink, fontSize: 12.5, fontWeight: 600 }}
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

/** A checkpoint slot in the store lane. `filled` = a completed checkpoint exists. */
function Slot({
  cx,
  y,
  h,
  filled,
  line1,
  line2,
}: {
  cx: number;
  y: number;
  h: number;
  filled: boolean;
  line1: string;
  line2: string;
}) {
  const x = cx - SLOT_W / 2;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={SLOT_W}
        height={h}
        rx={8}
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
        style={{ fill: filled ? ink : muted, fontSize: 10.5, fontWeight: 600, fontFamily: mono }}
      >
        {line1}
      </text>
      <text
        x={cx}
        y={y + 33}
        textAnchor="middle"
        style={{ fill: muted, fontSize: 10, fontFamily: mono }}
      >
        {line2}
      </text>
    </g>
  );
}

/** A short vertical connector with an arrowhead at (cx, y2), optionally labelled to its left. */
function VArrow({
  cx,
  y1,
  y2,
  label,
}: {
  cx: number;
  y1: number;
  y2: number;
  label?: string;
}) {
  return (
    <g>
      <line
        x1={cx}
        y1={y1}
        x2={cx}
        y2={y2}
        style={{ stroke: muted, strokeWidth: 1.5 }}
        markerEnd="url(#rarrow)"
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

const STEPS = [
  { idx: 'step[0]', name: 'reserveStock' },
  { idx: 'step[1]', name: 'chargeCard' },
  { idx: 'step[2]', name: 'ship' },
];

/**
 * The checkpoint-and-replay mechanism, drawn as three column-aligned bands: first run (top) →
 * checkpoint store (middle) → replay after crash (bottom). Theme-aware (light/dark, per-site
 * primary) via Fumadocs' CSS variables.
 */
export function ReplayDiagram() {
  return (
    <figure className="my-6 overflow-hidden rounded-xl border border-fd-border bg-fd-card p-4">
      <svg
        viewBox="0 0 720 292"
        width="100%"
        role="img"
        aria-label="Checkpoint and deterministic replay across a crash"
      >
        <title>
          The first run executes each step and writes a checkpoint; after a crash, replay returns
          the saved output for completed checkpoints and executes only the step that has none.
        </title>
        <defs>
          <marker
            id="rarrow"
            viewBox="0 0 10 10"
            refX={8}
            refY={5}
            markerWidth={6}
            markerHeight={6}
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: muted }} />
          </marker>
          <filter id="rsoft" x="-8%" y="-8%" width="116%" height="130%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.12" />
          </filter>
        </defs>

        {/* Faint per-column guides tie each step across the three bands. */}
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

        {/* Column headers: step index + name. */}
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

        {/* Left band labels. */}
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

        {/* First run: execute step[0] and step[1], then crash before step[2]. */}
        <Cell cx={COLS[0]} y={48} h={62} variant="exec" title="execute" sub="→ checkpoint" />
        <Cell cx={COLS[1]} y={48} h={62} variant="exec" title="execute" sub="→ checkpoint" />
        <Cell cx={COLS[2]} y={48} h={62} variant="crash" title="💥 crash" sub="never reached" />

        {/* Checkpoint store: seq:0 and seq:1 completed; seq:2 has none. */}
        <Slot cx={COLS[0]} y={134} h={44} filled line1="seq:0 · completed" line2="saved output" />
        <Slot cx={COLS[1]} y={134} h={44} filled line1="seq:1 · completed" line2="saved output" />
        <Slot cx={COLS[2]} y={134} h={44} filled={false} line1="seq:2 · none" line2="—" />

        {/* Replay: completed checkpoints return saved output; the uncheckpointed step executes. */}
        <Cell cx={COLS[0]} y={204} h={64} variant="saved" title="return saved" sub="not re-run" />
        <Cell cx={COLS[1]} y={204} h={64} variant="saved" title="return saved" sub="not re-run" />
        <Cell
          cx={COLS[2]}
          y={204}
          h={64}
          variant="exec"
          title="execute for real"
          sub="no checkpoint"
        />

        {/* Write down on first run; return up on replay (only where a checkpoint exists). */}
        <VArrow cx={COLS[0]} y1={110} y2={134} label="write" />
        <VArrow cx={COLS[1]} y1={110} y2={134} />
        <VArrow cx={COLS[0]} y1={178} y2={204} label="return" />
        <VArrow cx={COLS[1]} y1={178} y2={204} />
      </svg>
      <figcaption className="mt-2 border-t border-fd-border px-1 pt-2 text-xs text-fd-muted-foreground">
        Recovery re-runs the workflow from the top. A completed checkpoint short-circuits its step
        and returns the saved output; only the step with no checkpoint executes for real.
      </figcaption>
    </figure>
  );
}
