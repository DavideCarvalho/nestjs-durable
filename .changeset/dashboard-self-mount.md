---
'@dudousxd/nestjs-durable-dashboard': minor
---

Mount the console yourself, and let `decorators` count as protection.

- **`routes: false`** on `DurableDashboardModule.forRoot` mounts no controllers while every provider
  still registers (the run read/action service, the run filter, the SPA's paths). Serve the console
  from your own controllers by extending the new exported bases, `DurableUiControllerBase` and
  `DurableApiControllerBase`, and protect them with ordinary Nest decorators (`@UseGuards`,
  `@nestjs/authorization`'s `@Can`). The bases carry no guards and no `Can.Anyone()` mark, so a
  subclass without a `@Can()` is denied by `AuthorizationModule`'s global guard. The fail-closed
  production gate does not apply to a self-mounted console, and `guards`, `decorators`,
  `dashboardAuth`, `token` and `allowUnauthenticated` throw at boot when combined with
  `routes: false`, rather than being silently ignored.
- **A non-empty `decorators` now counts as the console's protection**, like `guards`: the
  fail-closed production gate steps aside, so
  `decorators: [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]` no longer needs
  `allowUnauthenticated: true`.
- `DurableUiController` and `DurableApiController` are now subclasses of the new bases. Guards and
  the open mark are applied to them, as before, never to the bases.
- Docs: a single "Protecting the console" section recommends mounting it yourself, then
  `decorators`, and keeps `guards`, `dashboardAuth`, the token and `allowUnauthenticated` as
  compatibility options.
