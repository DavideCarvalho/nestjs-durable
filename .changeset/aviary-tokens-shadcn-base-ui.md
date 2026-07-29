---
'@dudousxd/nestjs-durable-dashboard': minor
---

Adopt the shared Aviary console tokens and put the console's primitives on shadcn + Base UI.

The four Aviary consoles (agent, durable, media, telescope) are meant to read as siblings, and the
only way that survives four separate repos is a written definition plus honest copies of it. The
console now carries the canonical token block from `AVIARY-UI.md` — the neutrals it already had,
plus the `--panel-2` elevated surface and the `--good` / `--warn` / `--bad` / `--live` status set it
was missing — with a comment naming the source, so the next person copying knows where it came from.
The status hues in `index.css` are built from those tokens instead of repeating their hex values,
and the brand accent (logo, primary action, selection ring, background glow) now resolves through
`--accent` rather than a hard-coded emerald, so changing the accent is one line.

Adopting `--live` (in flight) settled a disagreement the console had with itself: a running step was
blue in the run list and in the step badges, but amber in the workflow graph — where amber is
`--warn`'s job (suspended / awaiting). The graph's in-flight node and its animated edge are now the
same `--live` blue as everything else that means "a worker is running this right now".

Tailwind maps shadcn's semantic colour names onto those tokens, so a vendored primitive's
`bg-background` / `border-border` / `text-muted-foreground` lands on the Aviary neutrals rather than
shadcn's defaults. The primitives live in `src/app/ui/` (Button, Badge, Input, Tabs, Tooltip,
Popover, Dialog) and are used across the console.

Behaviour that changes for the better:

- The pod / partition / overflow popovers in the header are real popovers: they dismiss on an
  outside click and on Escape, return focus to their trigger, and are portalled, so they can no
  longer be clipped by the header's fixed-width slot.
- The workers panel toggle is a real tab list — arrow-key navigation, `role="tablist"`, tab/panel
  wiring — instead of three plain buttons.
- Tooltips are portalled and collision-aware instead of hard-pinned below-right.
- Fix &amp; replay edits the run input in a proper dialog with a resizable JSON editor. It used to be
  `window.prompt`: a single-line box for a multi-line document, with `window.alert` reporting a parse
  error only *after* the edit had already been discarded. The dialog keeps the draft and shows the
  parse error inline.

New explicitly-declared packages: `@base-ui-components/react`, `class-variance-authority`, `clsx`,
`tailwind-merge`. They are bundled into the shipped SPA and are not part of any published entry
point, so they are dev dependencies — nothing is added to what a host application installs.

`preview.html` gains a `?view=console` mode that renders the whole console against a stubbed API, so
the full screen can be reviewed and screenshotted without a server, a database or a worker.

The console's accent is unchanged. It is currently the same value as `--good`, which is a real
ambiguity in a console whose primary information is run status — that is a brand decision, not a
refactor, so it is flagged rather than made.

`reflect-metadata` is now declared as a peer dependency. The server entry has always imported it
(`durable-dashboard.module.ts` line 1) while only listing it as a dev dependency — the same shape as
the `telescope-ui` incident, just benign in practice because every NestJS host already installs it.
A new test bundles each published entry with esbuild and asserts that every package the bundler
actually resolves is declared; that is what found it.
