'use client';

// Interactive operator+tenants scene for the tenancy docs. Hand-authored SVG, no animation deps —
// a token is moved between waypoints and CSS-transitions there. Send a run from a tenant and watch
// start-run → dispatch → reply travel the transport; or try to read another tenant's run and watch
// the operator reject it with a cross-tenant error, showing the isolation boundary live.
//
// Degrades without JS: SSR renders the static topology (operator · transport · two tenants) with a
// prompt to interact. Theme-aware via Fumadocs' `--color-fd-*` variables; respects reduced motion.

import { useEffect, useState } from 'react';

const ink = 'var(--color-fd-foreground)';
const muted = 'var(--color-fd-muted-foreground)';
const card = 'var(--color-fd-card)';
const border = 'var(--color-fd-border)';
const accent = 'var(--color-fd-primary)';
const accentSoft = 'color-mix(in srgb, var(--color-fd-primary) 14%, transparent)';
const danger = '#e5484d';
const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

type Tone = 'go' | 'deny';
type Highlight = 'none' | 'op' | 'blue' | 'green' | 'op-deny' | 'blue-deny';
type Stage = { x: number; y: number; label: string; tone: Tone; hi: Highlight; caption: string };

// Waypoints: tenant edge → transport → operator edge (and back).
const BLUE = { x: 512, y: 88 };
const GREEN = { x: 512, y: 216 };
const BUS_B = { x: 410, y: 120 };
const BUS_G = { x: 410, y: 190 };
const OP = { x: 258, y: 150 };

function happyPath(name: 'blue' | 'green'): Stage[] {
  const t = name === 'blue' ? BLUE : GREEN;
  const bus = name === 'blue' ? BUS_B : BUS_G;
  const hiTenant = name;
  return [
    {
      ...t,
      label: 'start-run',
      tone: 'go',
      hi: 'none',
      caption: `${name} asks the operator to create a run (start-run).`,
    },
    { ...bus, label: 'start-run', tone: 'go', hi: 'none', caption: '…proxied over the transport.' },
    {
      ...OP,
      label: '',
      tone: 'go',
      hi: 'op',
      caption: `Operator creates run@${name}, stamped namespace=${name} · status pending.`,
    },
    {
      ...bus,
      label: 'dispatch',
      tone: 'go',
      hi: 'none',
      caption: `Operator dispatches it to ${name}'s queue (handler@${name}).`,
    },
    {
      ...t,
      label: '',
      tone: 'go',
      hi: hiTenant,
      caption: `${name} runs the step (store-less — it does the work).`,
    },
    {
      ...bus,
      label: 'reply',
      tone: 'go',
      hi: 'none',
      caption: `${name} replies with the result over the transport.`,
    },
    {
      ...OP,
      label: '',
      tone: 'go',
      hi: 'op',
      caption: `Operator records the result. run@${name} completed.`,
    },
  ];
}

const CROSS_TENANT: Stage[] = [
  {
    ...BLUE,
    label: 'read run@green',
    tone: 'deny',
    hi: 'none',
    caption: 'Blue asks to read a run that belongs to green.',
  },
  {
    ...BUS_B,
    label: 'read run@green',
    tone: 'deny',
    hi: 'none',
    caption: 'Request proxied to the operator.',
  },
  {
    ...OP,
    label: '',
    tone: 'deny',
    hi: 'op-deny',
    caption: 'Operator loads the run, sees namespace=green ≠ blue → rejects.',
  },
  {
    ...BUS_B,
    label: 'cross-tenant ✗',
    tone: 'deny',
    hi: 'none',
    caption: 'cross-tenant error returned — before any read runs.',
  },
  {
    ...BLUE,
    label: '',
    tone: 'deny',
    hi: 'blue-deny',
    caption: 'A tenant only ever sees its own runs. Isolation holds.',
  },
];

function Node({
  x,
  y,
  w,
  h,
  title,
  rows,
  primary,
  highlight,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  rows: string[];
  primary?: boolean;
  highlight: 'none' | 'go' | 'deny';
}) {
  const lit = highlight !== 'none';
  const ringColor = highlight === 'deny' ? danger : accent;
  const stroke = lit ? ringColor : primary ? accent : border;
  return (
    <g className="tf-anim">
      {lit ? (
        <rect
          x={x - 4}
          y={y - 4}
          width={w + 8}
          height={h + 8}
          rx={14}
          className="tf-anim"
          style={{ fill: 'none', stroke: ringColor, strokeWidth: 2, opacity: 0.5 }}
        />
      ) : null}
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={12}
        className="tf-anim"
        style={{ fill: card, stroke, strokeWidth: lit || primary ? 1.5 : 1 }}
        filter="url(#tf-soft)"
      />
      {primary ? <rect x={x} y={y} width={4} height={h} rx={2} style={{ fill: accent }} /> : null}
      <text x={x + 16} y={y + 25} style={{ fill: ink, fontSize: 13, fontWeight: 600 }}>
        {title}
      </text>
      {rows.map((row, i) => (
        <text
          key={row}
          x={x + 16}
          y={y + 46 + i * 17}
          style={{ fill: muted, fontSize: 11, fontFamily: mono }}
        >
          {row}
        </text>
      ))}
    </g>
  );
}

function Link({
  x1,
  y1,
  x2,
  y2,
  label,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
}) {
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        style={{ stroke: border, strokeWidth: 1.25 }}
        strokeDasharray="4 4"
      />
      <text
        x={(x1 + x2) / 2}
        y={(y1 + y2) / 2 - 7}
        textAnchor="middle"
        style={{ fill: muted, fontSize: 10, fontFamily: mono }}
      >
        {label}
      </text>
    </g>
  );
}

export function TenantFlow() {
  const [scenario, setScenario] = useState<Stage[]>([]);
  const [stage, setStage] = useState(-1);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    if (stage < 0 || stage >= scenario.length - 1) return;
    const id = setTimeout(() => setStage((s) => s + 1), reduced ? 350 : 750);
    return () => clearTimeout(id);
  }, [stage, scenario.length, reduced]);

  function run(s: Stage[]) {
    setScenario(s);
    setStage(0);
  }

  const active = stage >= 0 ? scenario[stage] : undefined;
  const hi = active?.hi ?? 'none';
  const opHi = hi === 'op' ? 'go' : hi === 'op-deny' ? 'deny' : 'none';
  const blueHi = hi === 'blue' ? 'go' : hi === 'blue-deny' ? 'deny' : 'none';
  const greenHi = hi === 'green' ? 'go' : 'none';
  const tokenColor = active?.tone === 'deny' ? danger : accent;

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
        .tf-anim { transition: opacity .3s ease, stroke .3s ease, stroke-width .3s ease; }
        .tf-token { transition: transform .65s cubic-bezier(.4,0,.2,1); }
        @media (prefers-reduced-motion: reduce) { .tf-anim, .tf-token { transition: none } }
      `}</style>
      <svg
        viewBox="0 0 760 300"
        width="100%"
        role="img"
        aria-label="Interactive operator and tenants: a run travels the transport, and cross-tenant reads are rejected"
      >
        <title>
          A control-plane operator and two tenant workers wired over the transport. Enqueue a run to
          watch start-run, dispatch and reply travel between a tenant and the operator; or read
          another tenant's run to see the operator reject it with a cross-tenant error.
        </title>
        <defs>
          <filter id="tf-soft" x="-8%" y="-8%" width="116%" height="130%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.12" />
          </filter>
        </defs>

        {/* Transport bus. */}
        <rect
          x={330}
          y={60}
          width={92}
          height={180}
          rx={46}
          style={{ fill: accentSoft, stroke: border, strokeWidth: 1 }}
        />
        <text
          x={376}
          y={146}
          textAnchor="middle"
          style={{ fill: ink, fontSize: 12, fontWeight: 600 }}
        >
          Transport
        </text>
        <text
          x={376}
          y={163}
          textAnchor="middle"
          style={{ fill: muted, fontSize: 10.5, fontFamily: mono }}
        >
          (Redis)
        </text>

        {/* Static links. */}
        <Link x1={248} y1={150} x2={330} y2={150} label="control + reads" />
        <Link x1={422} y1={110} x2={512} y2={88} label="run@blue" />
        <Link x1={422} y1={200} x2={512} y2={216} label="run@green" />

        {/* Nodes. */}
        <Node
          x={24}
          y={86}
          w={224}
          h={128}
          primary
          highlight={opHi}
          title="Control plane · operator"
          rows={[
            'engine · store · dashboard',
            'namespace: — (drives all)',
            'sees every tenant’s runs',
          ]}
        />
        <Node
          x={512}
          y={40}
          w={224}
          h={96}
          highlight={blueHi}
          title="Tenant · blue"
          rows={['DURABLE_TENANT=blue · no store', 'handler@blue · ProxyRunGateway']}
        />
        <Node
          x={512}
          y={168}
          w={224}
          h={96}
          highlight={greenHi}
          title="Tenant · green"
          rows={['DURABLE_TENANT=green · no store', 'handler@green · ProxyRunGateway']}
        />

        {/* Travelling token. */}
        {active ? (
          <g className="tf-token" style={{ transform: `translate(${active.x}px, ${active.y}px)` }}>
            {active.label ? (
              <g>
                <rect
                  x={-58}
                  y={-34}
                  width={116}
                  height={19}
                  rx={9}
                  style={{ fill: card, stroke: tokenColor, strokeWidth: 1 }}
                />
                <text
                  x={0}
                  y={-21}
                  textAnchor="middle"
                  style={{ fill: tokenColor, fontSize: 10, fontFamily: mono }}
                >
                  {active.label}
                </text>
              </g>
            ) : null}
            <circle r={12} style={{ fill: tokenColor, stroke: card, strokeWidth: 2 }} />
          </g>
        ) : null}
      </svg>

      {/* Controls. */}
      <div
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }}
      >
        <button type="button" style={btn} onClick={() => run(happyPath('blue'))}>
          ▶ Enqueue run@blue
        </button>
        <button type="button" style={btn} onClick={() => run(happyPath('green'))}>
          ▶ Enqueue run@green
        </button>
        <button
          type="button"
          style={{ ...btn, borderColor: danger, color: danger }}
          onClick={() => run(CROSS_TENANT)}
        >
          ⚠ Blue reads green’s run
        </button>
        <button
          type="button"
          style={btn}
          onClick={() => {
            setStage(-1);
            setScenario([]);
          }}
        >
          ⟲ Reset
        </button>
      </div>
      <figcaption
        className="mt-2 border-t border-fd-border px-1 pt-2 text-xs text-fd-muted-foreground"
        aria-live="polite"
      >
        {active?.caption ??
          'Enqueue a run to watch it travel the transport — or read another tenant’s run to see the isolation boundary reject it.'}
      </figcaption>
    </figure>
  );
}
