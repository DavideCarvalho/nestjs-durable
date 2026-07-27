---
'@dudousxd/nestjs-durable-dashboard': minor
---

**`dashboardAuth` gains a `session` hook (Mode A) for hosts with their own auth.** Previously the durable console could only be gated by the built-in, server-rendered `login` page — forcing a host that already has its own identity provider (SSO/OIDC/whatever) to invent a shared credential this library could check.

- `dashboardAuth.session?: (request) => SessionUser | null` — the host frontend, already carrying its own auth, POSTs to `<basePath>/session`; the hook validates the raw request and returns the session user (or `null` to deny), and the library mints its usual signed cookie from that. No credential this library understands ever exists.
- `dashboardAuth.login` is now optional (Mode B, a standalone fallback with no host frontend/IdP to lean on) — at least one of `session`/`login` is still required, or `DurableDashboardModule.forRoot`/`forRootAsync` throws at boot (an un-mintable gate is a boot error, not a silently-open or silently-stuck console).
- A Mode-A-only mount serves a small instruction page in place of the login redirect (there is no login page to redirect to) when a page-level request has no valid session.

Compatible with existing `dashboardAuth: { secret, login }` configs unchanged.
