---
'@dudousxd/nestjs-durable-dashboard': minor
---

**Dashboard auth gains Mode A (`session`) and a `revalidate` hook; `login` is now optional.** Previously the durable console could only be gated by the built-in, server-rendered `login` page — forcing a host that already has its own identity provider (SSO/OIDC/whatever) to invent a shared credential this library could check. And once a session cookie was minted, the sliding renewal that kept an active tab logged in never re-checked the user, so a deactivated or demoted operator kept console access for as long as the tab stayed open.

- `dashboardAuth.session?: (request) => SessionUser | null` — the host frontend, already carrying its own auth, POSTs to `<basePath>/session`; the hook validates the raw request and returns the session user (or `null` to deny), and the library mints its usual signed cookie from that. No credential this library understands ever exists.
- `dashboardAuth.login` is now optional (Mode B, a standalone fallback with no host frontend/IdP to lean on) — at least one of `session`/`login` is still required, or `DurableDashboardModule.forRoot`/`forRootAsync` throws at boot (an un-mintable gate is a boot error, not a silently-open or silently-stuck console).
- A Mode-A-only mount serves a small instruction page in place of the login redirect (there is no login page to redirect to) when a page-level request has no valid session.
- `dashboardAuth.revalidate?: (session) => Promise<boolean> | boolean` — re-checks a *live* session on the sliding renewal path (at most once per `ttl/2` per session, so a DB round-trip is cheap). Returning `false`, or throwing, clears the cookie and denies the request in place — the same treatment as an absent cookie. Distinct from `session`: that hook reads the host's own auth off a fresh request, which a console XHR does not carry; `revalidate` receives the already-minted session instead. `revalidate` alone cannot mint a session, so it doesn't count toward the `session`/`login` "at least one" requirement.

Compatible with existing `dashboardAuth: { secret, login }` configs unchanged.
