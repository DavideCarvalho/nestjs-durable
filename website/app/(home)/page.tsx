import {
  Activity,
  ArrowRight,
  Clock,
  Database,
  Eye,
  FlaskConical,
  GitBranch,
  Network,
  Repeat,
  Terminal,
  Workflow,
} from 'lucide-react';
import Link from 'next/link';
import { LiveRun } from './live-run';

const GITHUB_URL = 'https://github.com/DavideCarvalho/nestjs-durable';

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <BackgroundTexture />
      <Hero />
      <RunPreview />
      <FeatureGrid />
      <WireItIn />
      <FinalCta />
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*  Background — dot grid + emerald glow, CSS only                             */
/* -------------------------------------------------------------------------- */

function BackgroundTexture() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.35] dark:opacity-[0.5]"
        style={{
          backgroundImage:
            'radial-gradient(circle at center, var(--color-fd-border) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 20%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, black 20%, transparent 75%)',
        }}
      />
      <div
        className="absolute -top-40 left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, rgb(16 185 129 / 0.18) 0%, rgb(16 185 129 / 0.05) 40%, transparent 70%)',
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero                                                                        */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col items-center px-4 pb-10 pt-20 text-center sm:pt-28">
      <div className="tele-stagger flex flex-col items-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card/60 px-3 py-1 font-mono text-xs text-fd-muted-foreground backdrop-blur">
          <span className="relative flex h-2 w-2">
            <span className="animate-tele-blink absolute inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          Durable execution, the NestJS way
        </span>

        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          Workflows that{' '}
          <span className="bg-gradient-to-r from-emerald-500 to-teal-400 bg-clip-text text-transparent">
            survive anything.
          </span>
        </h1>

        <p className="mt-6 max-w-2xl text-pretty text-lg text-fd-muted-foreground">
          Write a workflow as plain async code. Every step is checkpointed, so it resumes exactly
          where it stopped after a crash or deploy — and steps can run across apps and languages,
          even a Python worker. One flow, one source of truth, one control plane.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="group inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-5 py-2.5 font-medium text-zinc-950 shadow-[0_0_24px_-6px] shadow-emerald-500/50 transition-all hover:bg-emerald-400 hover:shadow-emerald-400/60"
          >
            Get started
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link
            href="/docs/getting-started"
            className="rounded-lg border border-fd-border bg-fd-card/40 px-5 py-2.5 font-medium backdrop-blur transition-colors hover:bg-fd-accent"
          >
            Install in 5 minutes
          </Link>
          <a
            href={GITHUB_URL}
            className="rounded-lg border border-fd-border bg-fd-card/40 px-5 py-2.5 font-medium backdrop-blur transition-colors hover:bg-fd-accent"
          >
            GitHub
          </a>
        </div>

        <p className="mt-6 font-mono text-xs text-fd-muted-foreground">
          checkpointed replay · cross-app & Python steps · durable sleep & signals · control plane
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Run preview — a workflow as one timeline across apps                       */
/* -------------------------------------------------------------------------- */

function RunPreview() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-24">
      <div className="relative">
        <div
          aria-hidden
          className="absolute -inset-x-10 -bottom-8 top-10 -z-10 rounded-[2rem] bg-emerald-500/10 blur-3xl"
        />
        <div className="grid items-center gap-5 lg:grid-cols-[0.9fr_1.1fr]">
          {/* the workflow code */}
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-black/30 ring-1 ring-white/5">
            <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
              <Terminal className="size-3.5 text-zinc-500" />
              <span className="font-mono text-xs text-zinc-500">checkout.workflow.ts</span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
              <code>
                <span className="text-zinc-500">await</span>{' '}
                <span className="text-zinc-300">ctx.</span>
                <span className="text-sky-400">step</span>
                <span className="text-zinc-300">(reserveStock);</span>
                {'\n'}
                <span className="text-zinc-500">const</span>
                <span className="text-zinc-300"> c = </span>
                <span className="text-zinc-500">await</span>{' '}
                <span className="text-zinc-300">ctx.</span>
                <span className="text-sky-400">call</span>
                <span className="text-zinc-300">(chargeCard, …);</span>
                {'\n'}
                <span className="text-zinc-500">await</span>{' '}
                <span className="text-zinc-300">ctx.</span>
                <span className="text-sky-400">sleep</span>
                <span className="text-zinc-300">(</span>
                <span className="text-teal-300">'2 days'</span>
                <span className="text-zinc-300">);</span>
                {'\n'}
                <span className="text-zinc-500">await</span>{' '}
                <span className="text-zinc-300">ctx.</span>
                <span className="text-sky-400">call</span>
                <span className="text-zinc-300">(ship, …);</span>
              </code>
            </pre>
            <p className="border-t border-zinc-800/60 px-5 py-3 font-mono text-[11px] leading-relaxed text-zinc-600">
              linear code, every step checkpointed.
              <br />
              crash mid-run → resumes from the last one.
            </p>
          </div>

          {/* the live, animated run */}
          <LiveRun />
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Feature grid                                                                */
/* -------------------------------------------------------------------------- */

interface Feature {
  icon: typeof Workflow;
  title: string;
  body: string;
  accent: string;
}

const FEATURES: readonly Feature[] = [
  {
    icon: Repeat,
    title: 'Crash-proof by replay',
    body: 'Each step records its result. On a crash or deploy the workflow re-runs from the top, but completed steps replay from their checkpoints — so they run exactly once and only the unfinished work executes.',
    accent: 'text-emerald-400',
  },
  {
    icon: Network,
    title: 'Steps across apps & languages',
    body: 'Call a typed remote step and the engine dispatches it over the transport — to another process, or a Python worker on the same queue. The workflow code never changes; only the transport does.',
    accent: 'text-sky-400',
  },
  {
    icon: Clock,
    title: 'Durable sleep & signals',
    body: "Pause for minutes or months with ctx.sleep — zero compute while waiting. Wait on a human approval or webhook with ctx.waitForSignal. Both survive restarts and resume on their own.",
    accent: 'text-amber-400',
  },
  {
    icon: Workflow,
    title: 'Workflow-as-code',
    body: 'Decorate a provider with @Workflow and write linear async code; mark step handlers with @DurableStep. The flow reads top to bottom — no state machines, no scattered queue glue.',
    accent: 'text-violet-400',
  },
  {
    icon: Database,
    title: 'Bring your ORM',
    body: 'State lives in Postgres through a StateStore interface. Ship with MikroORM and TypeORM adapters (Prisma next), with auto-schema on boot — or call the ensure helper from your own migration.',
    accent: 'text-teal-400',
  },
  {
    icon: Eye,
    title: 'See the whole flow',
    body: 'A built-in control plane renders each run as a graph across local and remote steps, with retry and cancel. Plus OpenTelemetry traces and a nestjs-telescope watcher — three views of one event log.',
    accent: 'text-fuchsia-400',
  },
  {
    icon: GitBranch,
    title: 'Retries, fan-out, fatal errors',
    body: 'Per-step retries with backoff, parallel steps via Promise.all with deterministic checkpoints, and FatalError to stop retrying a business failure outright.',
    accent: 'text-cyan-400',
  },
  {
    icon: Activity,
    title: 'Self-healing on boot',
    body: 'On startup the engine resumes every run a previous process left running, and a timer poller wakes any durable sleep that has come due. No orphaned workflows.',
    accent: 'text-orange-400',
  },
  {
    icon: FlaskConical,
    title: 'Built to test',
    body: 'An in-memory store and transport run a whole workflow in a unit test — including crash-injection to prove replay resumes correctly. No Postgres, no Redis, no flake.',
    accent: 'text-rose-400',
  },
];

function FeatureGrid() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-24">
      <div className="mb-10 text-center">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Everything durable execution needs
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-fd-muted-foreground">
          Write the flow once. The engine handles queues, retries, persistence and recovery — and
          gives you a window into every run.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <FeatureCard key={feature.title} feature={feature} />
        ))}
      </div>
    </section>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  return (
    <div className="group relative overflow-hidden rounded-xl border border-fd-border bg-fd-card/50 p-5 backdrop-blur transition-colors hover:border-emerald-500/40">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(120px circle at top right, rgb(16 185 129 / 0.1), transparent 70%)',
        }}
      />
      <div className="relative">
        <span className="inline-flex size-9 items-center justify-center rounded-lg border border-fd-border bg-fd-background/60">
          <Icon className={`size-4.5 ${feature.accent}`} />
        </span>
        <h3 className="mt-4 font-medium">{feature.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">{feature.body}</p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Wire it in — code snippet with window chrome                               */
/* -------------------------------------------------------------------------- */

const CODE_LINES: readonly { tokens: { text: string; cls?: string }[] }[] = [
  {
    tokens: [
      { text: '@', cls: 'text-amber-300' },
      { text: 'Workflow', cls: 'text-sky-400' },
      { text: "({ name: " },
      { text: "'checkout'", cls: 'text-teal-300' },
      { text: ' })' },
    ],
  },
  {
    tokens: [
      { text: 'class ', cls: 'text-violet-400' },
      { text: 'Checkout', cls: 'text-emerald-400' },
      { text: ' {' },
    ],
  },
  {
    tokens: [
      { text: '  async ', cls: 'text-violet-400' },
      { text: 'run', cls: 'text-sky-400' },
      { text: '(ctx, order) {' },
    ],
  },
  {
    tokens: [
      { text: '    const charge = ' },
      { text: 'await', cls: 'text-violet-400' },
      { text: ' ctx.' },
      { text: 'call', cls: 'text-sky-400' },
      { text: '(chargeCard, order);' },
    ],
  },
  {
    tokens: [
      { text: '    ' },
      { text: 'await', cls: 'text-violet-400' },
      { text: ' ctx.' },
      { text: 'waitForSignal', cls: 'text-sky-400' },
      { text: '(' },
      { text: '`approve:${order.id}`', cls: 'text-teal-300' },
      { text: ');' },
    ],
  },
  {
    tokens: [
      { text: '    ' },
      { text: 'return', cls: 'text-violet-400' },
      { text: ' ctx.' },
      { text: 'step', cls: 'text-sky-400' },
      { text: '(ship);' },
    ],
  },
  { tokens: [{ text: '  }' }] },
  { tokens: [{ text: '}' }] },
];

function WireItIn() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-24">
      <div className="grid items-center gap-10 lg:grid-cols-2">
        <div>
          <span className="font-mono text-xs uppercase tracking-wider text-emerald-500">
            Wire it in
          </span>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            One class. That&apos;s the workflow.
          </h2>
          <p className="mt-4 text-fd-muted-foreground">
            A workflow is a plain provider with a{' '}
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">run(ctx)</code>{' '}
            method. Call steps through{' '}
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">ctx</code> —{' '}
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">step</code> for
            local work,{' '}
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">call</code> for a
            remote (or Python) step,{' '}
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">sleep</code> and{' '}
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">waitForSignal</code>{' '}
            to pause. Register the module once; the engine checkpoints the rest.
          </p>
          <Link
            href="/docs/getting-started"
            className="mt-6 inline-flex items-center gap-2 font-medium text-emerald-500 transition-colors hover:text-emerald-400"
          >
            Full setup guide
            <ArrowRight className="size-4" />
          </Link>
        </div>

        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-black/30 ring-1 ring-white/5">
          <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
            <Terminal className="size-3.5 text-zinc-500" />
            <span className="font-mono text-xs text-zinc-500">checkout.workflow.ts</span>
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
            <code>
              {CODE_LINES.map((line, lineIndex) => (
                <div key={lineIndex} className="whitespace-pre">
                  {line.tokens.map((token, tokenIndex) => (
                    <span key={tokenIndex} className={token.cls ?? 'text-zinc-300'}>
                      {token.text}
                    </span>
                  ))}
                  {line.tokens.length === 0 ? ' ' : null}
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Final CTA                                                                   */
/* -------------------------------------------------------------------------- */

function FinalCta() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-28">
      <div className="relative overflow-hidden rounded-2xl border border-fd-border bg-fd-card/60 px-6 py-14 text-center backdrop-blur">
        <div
          aria-hidden
          className="absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(ellipse 60% 100% at 50% 0%, rgb(16 185 129 / 0.14), transparent 70%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 opacity-[0.4]"
          style={{
            backgroundImage:
              'radial-gradient(circle at center, var(--color-fd-border) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            maskImage: 'radial-gradient(ellipse 70% 80% at 50% 50%, black, transparent 80%)',
            WebkitMaskImage: 'radial-gradient(ellipse 70% 80% at 50% 50%, black, transparent 80%)',
          }}
        />
        <span className="inline-flex items-center gap-2 font-mono text-xs text-emerald-500">
          <Workflow className="size-4" />
          <Clock className="size-4" />
          <Network className="size-4" />
        </span>
        <h2 className="mx-auto mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Stop gluing queues together.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-fd-muted-foreground">
          Write the flow as code, let it survive crashes, and watch every run end to end — across
          NestJS and Python, in one place.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="group inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-6 py-2.5 font-medium text-zinc-950 shadow-[0_0_24px_-6px] shadow-emerald-500/50 transition-all hover:bg-emerald-400 hover:shadow-emerald-400/60"
          >
            Get started
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <a
            href={GITHUB_URL}
            className="rounded-lg border border-fd-border bg-fd-background/40 px-6 py-2.5 font-medium transition-colors hover:bg-fd-accent"
          >
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
