---
"@dudousxd/nestjs-durable-dashboard": minor
---

**Behaviour change:** the console now fails closed in production when no authentication is configured.

Before, `DurableDashboardModule.forRoot()` / `forRootAsync()` with no `guards` and no `dashboardAuth` served the console (UI and JSON API, including retry/cancel) with no authentication in every environment. Now:

- With `NODE_ENV=production` (case-insensitive), an unconfigured console answers `403` on every UI and API request, and one error is logged at boot (context `DurableDashboard`) explaining how to configure it.
- In any other environment it is still served open, and one warning is logged at boot saying it will be denied in production.

The console counts as configured when any of these is set: a non-empty `guards`, `dashboardAuth` (or a `useDashboardAuth` that returns a config), `allowUnauthenticated: true`, or a token.

Two new options on `DurableDashboardOptions` and `DurableDashboardAsyncOptions`:

- `allowUnauthenticated?: boolean` serves the console with no auth from this module, in every environment, and logs a boot warning. Use it when a global guard, a reverse proxy or a private network already protects the mount.
- `token?: string` (defaults to `process.env.DURABLE_DASHBOARD_TOKEN`) requires every console request to carry the token as `Authorization: Bearer <token>`, `x-durable-token`, or `?token=` on GET/HEAD only, compared in constant time; otherwise `401`. It applies only when neither `guards` nor `dashboardAuth` is configured.

The gate is the new exported `DurableDashboardGateGuard`. It runs after the `dashboardAuth` session guard and before host `guards`, on the UI and API controllers only; the `/login`, `/session` and `/logout` routes are not gated.

Migration for production deployments that mount the console with no `guards` and no `dashboardAuth`, before upgrading:

1. Behind a global guard or authenticating proxy: add `allowUnauthenticated: true`.
2. Machine access only: set `DURABLE_DASHBOARD_TOKEN` (or the `token` option).
3. Browser operators: configure `dashboardAuth` or `guards`.

Apps that already pass `guards`, `dashboardAuth`, or a `forRootAsync` whose `useDashboardAuth` returns a config need no change.

The guard metadata stamped on `DurableUiController` / `DurableApiController` now includes `DurableDashboardGateGuard` when neither `guards` nor a static `dashboardAuth` is passed. Code that asserted those arrays exactly needs updating.
