---
'@dudousxd/nestjs-durable-dashboard': minor
---

The console moves onto the shared Aviary console kit: a sidebar shell (console switcher, MONITOR · Runs / Workers and OPERATIONS · Schedules, signed-in user, light/dark toggle, sign-out), a topbar with ⌘K, bundled Sora + JetBrains Mono, Tailwind 4 + React 19, skeletons, error boundaries and empty states on every page, light mode, and a phone-width drawer. Workers and Schedules are now pages (metric cards + tables) instead of header popovers; bulk retry/cancel asks for confirmation first.

⌘K searches each console on its own and streams the groups in as they answer (`GET <api>/consoles/search?q=&console=<id>` answers for one console). New `DurableDashboardModule.forRoot` options feed the sidebar footer: `viewer: (request) => ({ label, email?, role? })` (default: `request.user` read structurally) and `signOut: '/path' | { href } | { action, csrfToken? } | false` (default: the `account.signOut` an account console announces on the Aviary consoles registry). `DurableUiControllerBase.index()` is now async: a host subclass that overrides `index()` must make its override async too (`async index(request?): Promise<string>`).
