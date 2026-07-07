'use client';

// An ambient, Encore-style queue simulation for the flow-control docs: runs dispatch
// steps (dots) into a durable queue; the admission gate feeds a fixed pool of worker
// slots; done work piles up on the right. Live controls (rate / concurrency / burst)
// let the reader FEEL backpressure: the queue absorbs a spike and drains at the
// configured concurrency, nothing is lost, nothing melts.
//
// Canvas + requestAnimationFrame (many moving dots — CSS transitions don't fit),
// theme-aware by sampling the Fumadocs CSS variables (re-sampled when the `dark`
// class flips), paused when offscreen and under `prefers-reduced-motion`.

import { useEffect, useRef, useState } from 'react';

const GREEN = '#30a46c';
const AMBER = '#f5a524';

const W = 920;
const H = 260;

const PRODUCER = { x: 96, y: 130 };
const QUEUE = { x: 250, y: 96, w: 240, h: 68 };
const WORKERS_X = 610;
const DONE = { x: 812, y: 130 };

type Phase = 'toQueue' | 'queued' | 'toWorker' | 'working' | 'toDone' | 'done';

type Dot = {
  phase: Phase;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  t: number; // 0..1 progress of the current move/work
  speed: number; // move progress per second
  workMs: number;
  slot: number; // worker slot index while working
  bornAt: number; // sim-time, for queue latency coloring
};

type Theme = {
  ink: string;
  muted: string;
  accent: string;
  border: string;
  card: string;
};

function sampleTheme(el: HTMLElement): Theme {
  const cs = getComputedStyle(el);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    ink: read('--color-fd-foreground', '#111'),
    muted: read('--color-fd-muted-foreground', '#777'),
    accent: read('--color-fd-primary', '#30a46c'),
    border: read('--color-fd-border', '#ccc'),
    card: read('--color-fd-card', '#fff'),
  };
}

function slotPos(slot: number, concurrency: number): { x: number; y: number } {
  const gap = 52;
  const y0 = 130 - ((concurrency - 1) * gap) / 2;
  return { x: WORKERS_X, y: y0 + slot * gap };
}

function queueSlotPos(index: number): { x: number; y: number } {
  // dots queue right-to-left inside the queue box, wrapping to a second row
  const perRow = 11;
  const row = Math.min(1, Math.floor(index / perRow));
  const col = index % perRow;
  return {
    x: QUEUE.x + QUEUE.w - 18 - col * 20,
    y: QUEUE.y + (row === 0 ? 22 : 46),
  };
}

export function QueueSim() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rate, setRate] = useState(3); // dots per second
  const [concurrency, setConcurrency] = useState(2);
  const [paused, setPaused] = useState(false);
  const burstRef = useRef(0);
  const countersRef = useRef({ queued: 0, inFlight: 0, done: 0 });

  // The knobs live in refs so the rAF loop reads fresh values without re-mounting.
  const rateRef = useRef(rate);
  const concurrencyRef = useRef(concurrency);
  rateRef.current = rate;
  concurrencyRef.current = concurrency;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let theme = sampleTheme(wrap);
    const themeObserver = new MutationObserver(() => {
      theme = sampleTheme(wrap);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Pause the sim while the diagram is offscreen — an ambient loop shouldn't cost
    // anything while the reader is elsewhere on the page.
    let visible = true;
    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
    });
    io.observe(wrap);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;

    const dots: Dot[] = [];
    let simMs = 0;
    let spawnCarry = 0;
    let doneCount = 0;
    let donePulse = 0;
    let last = performance.now();
    let raf = 0;

    function spawn() {
      dots.push({
        phase: 'toQueue',
        x: PRODUCER.x,
        y: PRODUCER.y,
        fromX: PRODUCER.x,
        fromY: PRODUCER.y,
        targetX: 0,
        targetY: 0,
        t: 0,
        speed: 2.2,
        workMs: 500 + Math.random() * 700,
        slot: -1,
        bornAt: simMs,
      });
    }

    function ease(t: number): number {
      return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    }

    function tick(now: number) {
      const dtMs = Math.min(64, now - last);
      last = now;
      if (!visible || paused) {
        raf = requestAnimationFrame(tick);
        return;
      }
      simMs += dtMs;
      const dt = dtMs / 1000;

      // spawn at `rate`/s (+ any pending burst, released quickly but not all at once)
      spawnCarry += rateRef.current * dt;
      if (burstRef.current > 0) {
        const release = Math.min(burstRef.current, Math.max(1, Math.round(30 * dt)));
        burstRef.current -= release;
        for (let i = 0; i < release; i++) spawn();
      }
      while (spawnCarry >= 1) {
        spawnCarry -= 1;
        spawn();
      }

      const conc = concurrencyRef.current;
      const working = dots.filter((d) => d.phase === 'working' || d.phase === 'toWorker');
      const queued = dots.filter((d) => d.phase === 'queued');
      // admission: FIFO from the queue into a free slot
      const busySlots = new Set(working.map((d) => d.slot));
      for (const dot of queued) {
        if (working.length >= conc) break;
        let free = -1;
        for (let sIdx = 0; sIdx < conc; sIdx++) if (!busySlots.has(sIdx)) { free = sIdx; break; }
        if (free < 0) break;
        busySlots.add(free);
        working.push(dot);
        const pos = slotPos(free, conc);
        dot.phase = 'toWorker';
        dot.slot = free;
        dot.fromX = dot.x;
        dot.fromY = dot.y;
        dot.targetX = pos.x;
        dot.targetY = pos.y;
        dot.t = 0;
        dot.speed = 2.4;
      }

      // advance every dot
      let queueIndex = 0;
      for (const dot of dots) {
        switch (dot.phase) {
          case 'toQueue': {
            const pos = queueSlotPos(Math.min(21, dots.filter((d) => d.phase === 'queued').length));
            dot.targetX = pos.x;
            dot.targetY = pos.y;
            dot.t += dot.speed * dt;
            if (dot.t >= 1) {
              dot.phase = 'queued';
              dot.x = dot.targetX;
              dot.y = dot.targetY;
            } else {
              const k = ease(dot.t);
              dot.x = dot.fromX + (dot.targetX - dot.fromX) * k;
              dot.y = dot.fromY + (dot.targetY - dot.fromY) * k;
            }
            break;
          }
          case 'queued': {
            // drift smoothly toward this dot's CURRENT position in the FIFO line
            const pos = queueSlotPos(Math.min(21, queueIndex));
            queueIndex += 1;
            dot.x += (pos.x - dot.x) * Math.min(1, 10 * dt);
            dot.y += (pos.y - dot.y) * Math.min(1, 10 * dt);
            break;
          }
          case 'toWorker': {
            // follow the slot even if concurrency changed mid-flight
            const pos = slotPos(dot.slot, Math.max(conc, dot.slot + 1));
            dot.targetX = pos.x;
            dot.targetY = pos.y;
            dot.t += dot.speed * dt;
            if (dot.t >= 1) {
              dot.phase = 'working';
              dot.x = dot.targetX;
              dot.y = dot.targetY;
              dot.t = 0;
            } else {
              const k = ease(dot.t);
              dot.x = dot.fromX + (dot.targetX - dot.fromX) * k;
              dot.y = dot.fromY + (dot.targetY - dot.fromY) * k;
            }
            break;
          }
          case 'working': {
            dot.t += dtMs / dot.workMs;
            if (dot.t >= 1) {
              dot.phase = 'toDone';
              dot.fromX = dot.x;
              dot.fromY = dot.y;
              dot.targetX = DONE.x;
              dot.targetY = DONE.y;
              dot.t = 0;
              dot.speed = 2.6;
            }
            break;
          }
          case 'toDone': {
            dot.t += dot.speed * dt;
            if (dot.t >= 1) {
              dot.phase = 'done';
              doneCount += 1;
              donePulse = 1;
            } else {
              const k = ease(dot.t);
              dot.x = dot.fromX + (dot.targetX - dot.fromX) * k;
              dot.y = dot.fromY + (dot.targetY - dot.fromY) * k;
            }
            break;
          }
          case 'done':
            break;
        }
      }
      // retire settled dots
      for (let i = dots.length - 1; i >= 0; i--) if (dots[i]?.phase === 'done') dots.splice(i, 1);
      donePulse = Math.max(0, donePulse - 2.4 * dt);

      countersRef.current = {
        queued: dots.filter((d) => d.phase === 'queued' || d.phase === 'toQueue').length,
        inFlight: dots.filter((d) => d.phase === 'working' || d.phase === 'toWorker').length,
        done: doneCount,
      };

      draw();
      raf = requestAnimationFrame(tick);
    }

    function roundRect(x: number, y: number, w: number, h: number, r: number) {
      if (!ctx2d) return;
      ctx2d.beginPath();
      ctx2d.roundRect(x, y, w, h, r);
    }

    function draw() {
      if (!ctx2d) return;
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, W, H);
      ctx2d.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      const conc = concurrencyRef.current;
      const c = countersRef.current;

      // flow guides
      ctx2d.strokeStyle = theme.border;
      ctx2d.setLineDash([4, 5]);
      ctx2d.lineWidth = 1;
      ctx2d.beginPath();
      ctx2d.moveTo(PRODUCER.x + 34, PRODUCER.y);
      ctx2d.lineTo(QUEUE.x - 8, PRODUCER.y);
      ctx2d.moveTo(QUEUE.x + QUEUE.w + 8, PRODUCER.y);
      ctx2d.lineTo(WORKERS_X - 40, PRODUCER.y);
      ctx2d.moveTo(WORKERS_X + 40, PRODUCER.y);
      ctx2d.lineTo(DONE.x - 34, PRODUCER.y);
      ctx2d.stroke();
      ctx2d.setLineDash([]);

      // producer
      ctx2d.fillStyle = theme.card;
      ctx2d.strokeStyle = theme.border;
      roundRect(PRODUCER.x - 64, PRODUCER.y - 34, 100, 68, 12);
      ctx2d.fill();
      ctx2d.stroke();
      ctx2d.fillStyle = theme.ink;
      ctx2d.fillText('runs', PRODUCER.x - 50, PRODUCER.y - 12);
      ctx2d.fillStyle = theme.muted;
      ctx2d.fillText('dispatch', PRODUCER.x - 50, PRODUCER.y + 6);
      ctx2d.fillText('ctx.step', PRODUCER.x - 50, PRODUCER.y + 22);

      // queue box — the border warms up as the backlog grows
      const pressure = Math.min(1, c.queued / 16);
      ctx2d.fillStyle = theme.card;
      ctx2d.strokeStyle = pressure > 0.5 ? AMBER : theme.border;
      ctx2d.lineWidth = 1 + pressure;
      roundRect(QUEUE.x, QUEUE.y, QUEUE.w, QUEUE.h, 12);
      ctx2d.fill();
      ctx2d.stroke();
      ctx2d.lineWidth = 1;
      ctx2d.fillStyle = theme.muted;
      ctx2d.fillText(`queue 'emails'`, QUEUE.x + 2, QUEUE.y - 8);
      ctx2d.fillStyle = c.queued > 8 ? AMBER : theme.muted;
      ctx2d.fillText(`${c.queued} waiting · zero compute`, QUEUE.x + 108, QUEUE.y - 8);

      // worker slots
      for (let sIdx = 0; sIdx < conc; sIdx++) {
        const pos = slotPos(sIdx, conc);
        const dot = dots.find((d) => d.phase === 'working' && d.slot === sIdx);
        ctx2d.strokeStyle = dot ? theme.accent : theme.border;
        ctx2d.fillStyle = theme.card;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, 16, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.stroke();
        if (dot) {
          // progress ring while the step runs
          ctx2d.strokeStyle = theme.accent;
          ctx2d.lineWidth = 2.5;
          ctx2d.beginPath();
          ctx2d.arc(pos.x, pos.y, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, dot.t));
          ctx2d.stroke();
          ctx2d.lineWidth = 1;
        }
      }
      ctx2d.fillStyle = theme.muted;
      ctx2d.fillText(`workers ${c.inFlight}/${conc}`, WORKERS_X - 34, slotPos(conc - 1, conc).y + 42);

      // done pile
      ctx2d.fillStyle = theme.card;
      ctx2d.strokeStyle = donePulse > 0 ? GREEN : theme.border;
      ctx2d.lineWidth = 1 + donePulse * 1.5;
      roundRect(DONE.x - 30, DONE.y - 34, 96, 68, 12);
      ctx2d.fill();
      ctx2d.stroke();
      ctx2d.lineWidth = 1;
      ctx2d.fillStyle = GREEN;
      ctx2d.font = '600 20px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx2d.fillText(String(doneCount), DONE.x - 14, DONE.y + 2);
      ctx2d.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx2d.fillStyle = theme.muted;
      ctx2d.fillText('completed', DONE.x - 14, DONE.y + 22);

      // dots
      for (const dot of dots) {
        if (dot.phase === 'done') continue;
        const waitedMs = simMs - dot.bornAt;
        const color = dot.phase === 'queued' ? (waitedMs > 3200 ? AMBER : theme.accent) : dot.phase === 'toDone' ? GREEN : theme.accent;
        ctx2d.fillStyle = color;
        ctx2d.beginPath();
        ctx2d.arc(dot.x, dot.y, dot.phase === 'working' ? 7 : 5.5, 0, Math.PI * 2);
        ctx2d.fill();
      }
    }

    if (reduced) {
      // static frame: seed a representative scene, draw once, never animate
      for (let i = 0; i < 5; i++) spawn();
      dots.forEach((d, i) => {
        const pos = queueSlotPos(i);
        d.phase = 'queued';
        d.x = pos.x;
        d.y = pos.y;
      });
      draw();
    } else {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      themeObserver.disconnect();
    };
  }, [paused]);

  const btn = {
    padding: '5px 12px',
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid var(--color-fd-border)',
    background: 'var(--color-fd-card)',
    color: 'var(--color-fd-foreground)',
    cursor: 'pointer',
  };

  return (
    <figure
      ref={wrapRef}
      className="my-6 rounded-2xl border border-fd-border p-3 sm:p-4"
      style={{ background: 'color-mix(in srgb, var(--color-fd-primary) 7%, var(--color-fd-card))' }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', maxWidth: W, display: 'block', margin: '0 auto', aspectRatio: `${W} / ${H}` }}
        role="img"
        aria-label="Simulation: runs dispatch steps into a durable queue; the admission gate feeds a fixed pool of worker slots; a burst of arrivals queues up (zero compute) and drains at the configured concurrency."
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 12.5, color: 'var(--color-fd-muted-foreground)' }}>
        <button type="button" style={btn} onClick={() => { burstRef.current += 14; }}>
          ⚡ burst +14
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          rate
          <input type="range" min={1} max={8} value={rate} onChange={(e) => setRate(Number(e.target.value))} style={{ width: 90 }} />
          <span className="tnum" style={{ minWidth: 34 }}>{rate}/s</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          concurrency
          {[1, 2, 4].map((n) => (
            <button
              key={n}
              type="button"
              style={{ ...btn, padding: '4px 10px', borderColor: n === concurrency ? 'var(--color-fd-primary)' : 'var(--color-fd-border)', color: n === concurrency ? 'var(--color-fd-foreground)' : 'var(--color-fd-muted-foreground)' }}
              onClick={() => setConcurrency(n)}
            >
              {n}
            </button>
          ))}
        </label>
        <button type="button" style={{ ...btn, marginLeft: 'auto' }} onClick={() => setPaused((p) => !p)}>
          {paused ? '▶ resume' : '⏸ pause'}
        </button>
      </div>
      <figcaption style={{ marginTop: 8, fontSize: 12.5, color: 'var(--color-fd-muted-foreground)', lineHeight: 1.5 }}>
        Live model of durable admission: hit <b>burst</b> and watch the queue absorb the spike — every
        blocked run waits suspended (zero compute, amber when it has waited a while) and drains
        FIFO at whatever <b>concurrency</b> allows. Nothing is dropped, nothing melts.
      </figcaption>
    </figure>
  );
}

// ── singleton variant ────────────────────────────────────────────────────────
// Per-KEY mutex lanes: dots carry a key (store:A/B/C, coloured); each key owns ONE
// slot, so same-key arrivals queue FIFO behind the in-flight run while other keys
// flow freely. Burst one key and watch only ITS lane back up.

const KEYS = [
  { label: 'store:A', color: '#6e79d6' },
  { label: 'store:B', color: '#0ea5e9' },
  { label: 'store:C', color: '#d6409f' },
];

const S_PRODUCER = { x: 96, y: 150 };
const LANE_Y = [72, 150, 228];
const SLOT_X = 600;
const S_DONE = { x: 812, y: 150 };
const S_H = 300;

type SDot = {
  key: number;
  phase: 'toLane' | 'queued' | 'working' | 'toDone' | 'done';
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  t: number;
  workMs: number;
  bornAt: number;
};

export function SingletonSim() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rate, setRate] = useState(2);
  const [paused, setPaused] = useState(false);
  const burstRef = useRef(0);
  const rateRef = useRef(rate);
  rateRef.current = rate;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let theme = sampleTheme(wrap);
    const themeObserver = new MutationObserver(() => {
      theme = sampleTheme(wrap);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    let visible = true;
    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
    });
    io.observe(wrap);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = S_H * dpr;

    const dots: SDot[] = [];
    let simMs = 0;
    let spawnCarry = 0;
    let doneCount = 0;
    let donePulse = 0;
    let last = performance.now();
    let raf = 0;

    function spawn(key: number) {
      dots.push({
        key,
        phase: 'toLane',
        x: S_PRODUCER.x,
        y: S_PRODUCER.y,
        fromX: S_PRODUCER.x,
        fromY: S_PRODUCER.y,
        t: 0,
        workMs: 900 + Math.random() * 900,
        bornAt: simMs,
      });
    }

    function ease(t: number): number {
      return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    }

    function laneQueuePos(key: number, index: number): { x: number; y: number } {
      return { x: SLOT_X - 46 - index * 19, y: LANE_Y[key] ?? 150 };
    }

    function tick(now: number) {
      const dtMs = Math.min(64, now - last);
      last = now;
      if (!visible || paused) {
        raf = requestAnimationFrame(tick);
        return;
      }
      simMs += dtMs;
      const dt = dtMs / 1000;

      spawnCarry += rateRef.current * dt;
      if (burstRef.current > 0) {
        const release = Math.min(burstRef.current, Math.max(1, Math.round(24 * dt)));
        burstRef.current -= release;
        for (let i = 0; i < release; i++) spawn(0); // burst hits store:A only
      }
      while (spawnCarry >= 1) {
        spawnCarry -= 1;
        spawn(Math.floor(Math.random() * KEYS.length));
      }

      // per-key mutex: admit the oldest queued dot of a key iff none of that key is working
      for (let key = 0; key < KEYS.length; key++) {
        const working = dots.some((d) => d.key === key && d.phase === 'working');
        if (working) continue;
        const next = dots.find((d) => d.key === key && d.phase === 'queued');
        if (next) {
          next.phase = 'working';
          next.x = SLOT_X;
          next.y = LANE_Y[key] ?? 150;
          next.t = 0;
        }
      }

      const perKeyIndex = [0, 0, 0];
      for (const dot of dots) {
        switch (dot.phase) {
          case 'toLane': {
            const idx = dots.filter((d) => d.key === dot.key && d.phase === 'queued').length;
            const pos = laneQueuePos(dot.key, Math.min(12, idx));
            dot.t += 2.2 * dt;
            if (dot.t >= 1) {
              dot.phase = 'queued';
              dot.x = pos.x;
              dot.y = pos.y;
            } else {
              const k = ease(dot.t);
              dot.x = dot.fromX + (pos.x - dot.fromX) * k;
              dot.y = dot.fromY + (pos.y - dot.fromY) * k;
            }
            break;
          }
          case 'queued': {
            const pos = laneQueuePos(dot.key, Math.min(12, perKeyIndex[dot.key] ?? 0));
            perKeyIndex[dot.key] = (perKeyIndex[dot.key] ?? 0) + 1;
            dot.x += (pos.x - dot.x) * Math.min(1, 10 * dt);
            dot.y += (pos.y - dot.y) * Math.min(1, 10 * dt);
            break;
          }
          case 'working': {
            dot.t += dtMs / dot.workMs;
            if (dot.t >= 1) {
              dot.phase = 'toDone';
              dot.fromX = dot.x;
              dot.fromY = dot.y;
              dot.t = 0;
            }
            break;
          }
          case 'toDone': {
            dot.t += 2.6 * dt;
            if (dot.t >= 1) {
              dot.phase = 'done';
              doneCount += 1;
              donePulse = 1;
            } else {
              const k = ease(dot.t);
              dot.x = dot.fromX + (S_DONE.x - dot.fromX) * k;
              dot.y = dot.fromY + (S_DONE.y - dot.fromY) * k;
            }
            break;
          }
          case 'done':
            break;
        }
      }
      for (let i = dots.length - 1; i >= 0; i--) if (dots[i]?.phase === 'done') dots.splice(i, 1);
      donePulse = Math.max(0, donePulse - 2.4 * dt);
      draw();
      raf = requestAnimationFrame(tick);
    }

    function draw() {
      if (!ctx2d) return;
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, W, S_H);
      ctx2d.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

      // producer
      ctx2d.fillStyle = theme.card;
      ctx2d.strokeStyle = theme.border;
      ctx2d.beginPath();
      ctx2d.roundRect(S_PRODUCER.x - 64, S_PRODUCER.y - 34, 100, 68, 12);
      ctx2d.fill();
      ctx2d.stroke();
      ctx2d.fillStyle = theme.ink;
      ctx2d.fillText('starts', S_PRODUCER.x - 50, S_PRODUCER.y - 10);
      ctx2d.fillStyle = theme.muted;
      ctx2d.fillText('sync-inventory', S_PRODUCER.x - 50, S_PRODUCER.y + 8);

      // lanes
      for (let key = 0; key < KEYS.length; key++) {
        const y = LANE_Y[key] ?? 150;
        const keyDef = KEYS[key];
        if (!keyDef) continue;
        ctx2d.strokeStyle = theme.border;
        ctx2d.setLineDash([4, 5]);
        ctx2d.beginPath();
        ctx2d.moveTo(S_PRODUCER.x + 40, S_PRODUCER.y);
        ctx2d.lineTo(230, y);
        ctx2d.lineTo(SLOT_X - 28, y);
        ctx2d.moveTo(SLOT_X + 28, y);
        ctx2d.lineTo(S_DONE.x - 36, S_DONE.y);
        ctx2d.stroke();
        ctx2d.setLineDash([]);

        const queuedN = dots.filter((d) => d.key === key && d.phase === 'queued').length;
        ctx2d.fillStyle = keyDef.color;
        ctx2d.fillText(keyDef.label, 236, y - 14);
        if (queuedN > 0) {
          ctx2d.fillStyle = queuedN > 5 ? AMBER : theme.muted;
          ctx2d.fillText(`${queuedN} gated`, 236 + 62, y - 14);
        }

        // the key's single slot (the mutex)
        const dot = dots.find((d) => d.key === key && d.phase === 'working');
        ctx2d.strokeStyle = dot ? keyDef.color : theme.border;
        ctx2d.fillStyle = theme.card;
        ctx2d.beginPath();
        ctx2d.arc(SLOT_X, y, 16, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.stroke();
        if (dot) {
          ctx2d.strokeStyle = keyDef.color;
          ctx2d.lineWidth = 2.5;
          ctx2d.beginPath();
          ctx2d.arc(SLOT_X, y, 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, dot.t));
          ctx2d.stroke();
          ctx2d.lineWidth = 1;
        }
      }
      ctx2d.fillStyle = theme.muted;
      ctx2d.fillText('limit: 1 per key', SLOT_X - 40, (LANE_Y[2] ?? 228) + 40);

      // done pile
      ctx2d.fillStyle = theme.card;
      ctx2d.strokeStyle = donePulse > 0 ? GREEN : theme.border;
      ctx2d.lineWidth = 1 + donePulse * 1.5;
      ctx2d.beginPath();
      ctx2d.roundRect(S_DONE.x - 30, S_DONE.y - 34, 96, 68, 12);
      ctx2d.fill();
      ctx2d.stroke();
      ctx2d.lineWidth = 1;
      ctx2d.fillStyle = GREEN;
      ctx2d.font = '600 20px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx2d.fillText(String(doneCount), S_DONE.x - 14, S_DONE.y + 2);
      ctx2d.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx2d.fillStyle = theme.muted;
      ctx2d.fillText('completed', S_DONE.x - 14, S_DONE.y + 22);

      // dots
      for (const dot of dots) {
        if (dot.phase === 'done') continue;
        ctx2d.fillStyle = dot.phase === 'toDone' ? GREEN : (KEYS[dot.key]?.color ?? theme.accent);
        ctx2d.globalAlpha = dot.phase === 'queued' ? 0.85 : 1;
        ctx2d.beginPath();
        ctx2d.arc(dot.x, dot.y, dot.phase === 'working' ? 7 : 5.5, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.globalAlpha = 1;
      }
    }

    if (reduced) {
      spawn(0);
      spawn(0);
      spawn(1);
      dots.forEach((d, i) => {
        d.phase = i === 0 ? 'working' : 'queued';
        const pos = i === 0 ? { x: SLOT_X, y: LANE_Y[0] ?? 72 } : laneQueuePos(d.key, i - 1);
        d.x = pos.x;
        d.y = pos.y;
      });
      draw();
    } else {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      themeObserver.disconnect();
    };
  }, [paused]);

  const btn = {
    padding: '5px 12px',
    fontSize: 12,
    borderRadius: 8,
    border: '1px solid var(--color-fd-border)',
    background: 'var(--color-fd-card)',
    color: 'var(--color-fd-foreground)',
    cursor: 'pointer',
  };

  return (
    <figure
      ref={wrapRef}
      className="my-6 rounded-2xl border border-fd-border p-3 sm:p-4"
      style={{ background: 'color-mix(in srgb, var(--color-fd-primary) 7%, var(--color-fd-card))' }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', maxWidth: W, display: 'block', margin: '0 auto', aspectRatio: `${W} / ${S_H}` }}
        role="img"
        aria-label="Simulation: starts for three singleton keys flow into per-key mutex lanes; same-key starts queue FIFO behind the in-flight run while other keys run in parallel."
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 10, fontSize: 12.5, color: 'var(--color-fd-muted-foreground)' }}>
        <button type="button" style={{ ...btn, borderColor: KEYS[0]?.color }} onClick={() => { burstRef.current += 8; }}>
          ⚡ burst store:A +8
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          rate
          <input type="range" min={1} max={6} value={rate} onChange={(e) => setRate(Number(e.target.value))} style={{ width: 90 }} />
          <span className="tnum" style={{ minWidth: 34 }}>{rate}/s</span>
        </label>
        <button type="button" style={{ ...btn, marginLeft: 'auto' }} onClick={() => setPaused((p) => !p)}>
          {paused ? '▶ resume' : '⏸ pause'}
        </button>
      </div>
      <figcaption style={{ marginTop: 8, fontSize: 12.5, color: 'var(--color-fd-muted-foreground)', lineHeight: 1.5 }}>
        Live model of <b>singleton</b> admission: each key owns one slot (a mutex). Burst{' '}
        <b>store:A</b> and only <b>its</b> lane backs up — gated starts wait suspended, FIFO, while
        store:B and store:C keep flowing. Different keys never contend.
      </figcaption>
    </figure>
  );
}
