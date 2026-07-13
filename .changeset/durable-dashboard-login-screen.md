---
'@dudousxd/nestjs-durable-dashboard': minor
---

**`dashboardAuth` — a built-in login screen for the console**, mirroring
`@dudousxd/nestjs-telescope`'s `dashboardAuth` mechanism (same HMAC-SHA256 signed session cookie,
same fail-closed validation) adapted to this dashboard's split UI/API controller topology. Unlike
Telescope's client-rendered login screen, the durable dashboard's login page is a small,
dependency-free, **server-rendered** HTML page served by a new `DurableAuthController` — the
bundled React SPA itself never changes.

```ts
DurableDashboardModule.forRoot({
  dashboardAuth: {
    secret: process.env.DURABLE_AUTH_SECRET, // required, 32+ bytes recommended
    ttl: '8h', // optional, default 8h
    login: (username, password) => (isValid(username, password) ? { id: 'ops' } : null),
  },
});
```

- `GET <basePath>/login` — the login page; `POST <basePath>/login` — validates credentials via the
  `login` hook and mints a `durable_dashboard_session` cookie (`HttpOnly`, `SameSite=Lax`, `Secure`
  over https), with a uniform `401` on any failure (unknown user, wrong password, a throwing hook)
  so there is no user-enumeration; `GET <basePath>/logout` clears it.
- **Page vs API gate:** a missing/invalid/expired session on a full-page navigation to `basePath`
  redirects (`302`) to the login page carrying `?returnTo=<original url>`; the same failure on the
  JSON API (`apiBasePath`) is a plain `401` — the built-in guards are `DurableUiSessionGuard` and
  `DurableApiSessionGuard`, both no-ops when `dashboardAuth` is unset.
- **Composes with the existing `guards` option** (added in the prior release): the built-in session
  guard is prepended to whatever `guards` you pass, so a request must clear the session check AND
  every host guard (logical AND, same as `@UseGuards` with multiple guards).
- **`DurableDashboardModule.forRootAsync(...)`** (new): resolves `dashboardAuth` from an injected
  factory (`inject` + `useDashboardAuth`) so the `login` hook can reach your DB/services (e.g. an
  `EntityManager` to look up a real admin user) instead of only closing over env vars.
- Omitting `dashboardAuth` (a plain `forRoot()` or `forRoot({ guards })`) reproduces today's
  behavior byte-for-byte — no new routes, no guard stamped.

Auth here is mount-level and role-agnostic — it has no notion of the dashboard's control-plane vs
tenant topology; nothing role-specific changes based on who logs in. Documented in a new "Console
auth" section (`dashboardAuth` vs `guards` vs open) in the dashboard docs.
