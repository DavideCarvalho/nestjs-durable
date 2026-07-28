---
'@dudousxd/nestjs-durable-dashboard': patch
---

**Three follow-ups from Mode A / `revalidate` code review, all backward compatible.**

- **Console auto-redirects on a mid-session 401.** Before `revalidate`, a mid-session 401 was rare; now it's routine (a deactivated/demoted operator's cookie is cleared on their next sliding renewal). The console's fetch wrapper used to surface that as a raw `401 Unauthorized` query error. It now sends the operator to the matching auth surface instead — the built-in login page (with `returnTo` back to where they were) under Mode B, or the Mode-A session-required page under Mode A. `DurableApiSessionGuard`'s 401 body now carries `{ auth: { modes } }` (mirroring `@dudousxd/nestjs-telescope`'s dashboardAuth 401) so the console can tell which mode is configured without guessing; an older/unaffected 401 (no body, or a body without `auth.modes`) still gets a safe fallback, not an error.
- **Concurrent `revalidate` calls for the same session are now de-duplicated.** `RevalidateHook`'s doc promises hosts "runs at most once per `ttl/2` per session, so a DB round-trip is cheap" — under real console traffic (a page load firing several parallel API calls) that wasn't quite true: each in-flight request independently called the hook before the first renewal's cookie landed. Concurrent renewals of the same session now share one host call; every caller still gets its own renewed (or cleared) cookie.
- **`ResolvedDashboardAuth.modes` is now the single source of truth for auth-mode decisions.** It was computed and exported but never read outside its own resolver — every runtime branch (the UI guard's redirect-vs-session-required choice, the auth controller's login/session/logout handlers) independently re-derived the same fact from hook-presence truthiness. Those now read `auth.modes`. No type or behavior change for existing configs.

No API changes — `dashboardAuth: { secret, login }` / `{ secret, session }` / `{ secret, session, revalidate }` configs are unaffected.
