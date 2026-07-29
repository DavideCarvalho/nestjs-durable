import type { Config } from 'tailwindcss';

/**
 * Aviary token → Tailwind colour.
 *
 * The tokens in `src/app/index.css` are hex custom properties (that is the shape `AVIARY-UI.md`
 * publishes, and the shape the other three consoles copy). A bare `var(--x)` cannot take Tailwind's
 * `/opacity` modifier, which this console leans on everywhere (`bg-emerald-500/10`, …); wrapping it
 * in `color-mix` restores it, so `bg-panel-2/60` behaves exactly like `bg-zinc-900/60`. When no
 * modifier is given Tailwind substitutes `1`, which mixes 100% of the token — the flat colour.
 */
const token = (name: string): string =>
  `color-mix(in srgb, var(${name}) calc(<alpha-value> * 100%), transparent)`;

export default {
  content: ['./index.html', './preview.html', './src/app/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        // ── shadcn's semantic names, resolved to Aviary tokens rather than shadcn's default
        // palette. This is what makes a vendored `bg-background` / `text-muted-foreground`
        // primitive land on this console's own neutrals with no edit.
        background: token('--bg'),
        foreground: token('--text'),
        card: { DEFAULT: token('--panel'), foreground: token('--text') },
        popover: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        primary: { DEFAULT: token('--accent'), foreground: token('--bg') },
        secondary: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        muted: { DEFAULT: token('--panel-2'), foreground: token('--muted') },
        // NOTE: shadcn's `accent` is its HOVER SURFACE, not a brand colour — it is deliberately the
        // elevated panel here. The Aviary brand accent is `brand` below. Two different meanings for
        // the same word; keeping them apart is why `brand` exists.
        accent: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        destructive: { DEFAULT: token('--bad'), foreground: token('--bg') },
        border: token('--line'),
        input: token('--line'),
        ring: token('--accent'),

        // ── Aviary's own names, for this console's hand-written classes.
        brand: token('--accent'),
        panel: token('--panel'),
        'panel-2': token('--panel-2'),
        line: token('--line'),
        'line-soft': token('--line-soft'),
        good: token('--good'),
        warn: token('--warn'),
        bad: token('--bad'),
        live: token('--live'),
      },
    },
  },
  plugins: [],
} satisfies Config;
