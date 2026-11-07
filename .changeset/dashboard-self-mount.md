---
'@dudousxd/nestjs-durable-dashboard': minor
---

**Breaking (0.x minor).** The console is now protected only with NestJS's first-party tools
(`@nestjs/authentication`, `@nestjs/authorization`), one of two ways, and the dashboard's own
access-control options are removed.

- **`decorators`** on `DurableDashboardModule.forRoot` takes class decorators and applies them to
  both mounted controllers (the SPA and its JSON API), like `@nestjs/mcp`'s option, e.g.
  `decorators: [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]`. Each registration
  that passes it mounts fresh subclasses, so decorators never leak into another registration or
  onto the exported classes.
- **`routes: false`** mounts no controllers while every provider still registers (the run
  read/action service, the run filter, the SPA's paths). Serve the console from your own
  controllers by extending the new exported bases, `DurableUiControllerBase` and
  `DurableApiControllerBase`, decorated with `@UseGuards` / `@Can`. The bases carry no guards and
  no `Can.Anyone()` mark, so a subclass without a `@Can()` is denied by `AuthorizationModule`'s
  global guard. `decorators` throws at boot when combined with `routes: false`.
- **Production rule.** With `NODE_ENV=production` (read at boot), a mounted console with no
  `decorators` (an empty array counts as none) fails the boot with an error naming both ways, with
  an example of each. Outside production it is served open, with one warning, and the mounted
  controllers are marked `Can.Anyone()` (the `authorization:can-anyone` metadata, written with no
  dependency on `@nestjs/authorization`) so the official deny-by-default guard does not lock it.
- **Removed:** `guards`, `dashboardAuth` (session cookie, built-in login page,
  `DurableAuthController`, the session guards, `DashboardAuthOptions` and related types),
  `forRootAsync` (it only existed to build `dashboardAuth` from DI), `token` and the
  `DURABLE_DASHBOARD_TOKEN` env var, `allowUnauthenticated`, the fail-closed gate
  (`DurableDashboardGateGuard` and its exports), and the cookie launcher (the `./react` subpath and
  `openDurableConsole` / `mintDurableConsoleSession` / `durableConsoleSessionUrl` /
  `durableConsoleUrl` / `ConsoleSessionError` from `./client`). `react` / `react-dom` are no longer
  peer dependencies. On a `401` from the API, the SPA now reloads `basePath` so your guard decides
  what happens next.

Migration:

| Before | Now |
| --- | --- |
| `guards: [JwtAuthGuard]` | `decorators: [UseGuards(JwtAuthGuard)]` (keep `imports` for its dependencies) |
| `dashboardAuth: { ... }` | `@nestjs/authentication` + `decorators: [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]` |
| `forRootAsync({ useDashboardAuth, ... })` | `forRoot({ decorators, ... })`; guards get their services by DI |
| `token` / `DURABLE_DASHBOARD_TOKEN` | your own header-checking guard through `decorators` |
| `allowUnauthenticated: true` | a decorator that states the protection (e.g. `UseGuards(ProxyAuthGuard)`), or `routes: false` |
| `openDurableConsole()` / `<OpenDurableConsoleButton />` | link to `basePath`; your guard authenticates the navigation |
