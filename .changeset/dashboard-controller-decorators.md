---
'@dudousxd/nestjs-durable-dashboard': minor
---

Add a `decorators` option to `DurableDashboardModule.forRoot` and `forRootAsync`. It takes class
decorators and applies them to every controller the dashboard mounts (UI, JSON API, and the
`dashboardAuth` login/logout controller), so the console can sit behind the first-party
`@nestjs/authentication` and `@nestjs/authorization`, e.g.
`[UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]`. Each registration that passes
`decorators` mounts fresh subclasses of the controllers, so its decorators never leak into another
registration or onto the exported classes.

The dashboard controllers are now also marked `Can.Anyone()` (the `authorization:can-anyone`
metadata, with no dependency on `@nestjs/authorization`), so `AuthorizationModule.forRoot()`'s
deny-by-default global guard no longer refuses the console. The dashboard's own `guards`,
`dashboardAuth`, token and fail-closed gate keep deciding who gets in, and a `Can()` passed
through `decorators` is still enforced.
