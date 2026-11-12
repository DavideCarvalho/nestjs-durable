---
"@dudousxd/nestjs-durable-dashboard": minor
---

One `authorize` option decides who may use the console (the SPA, its JSON API, the run stream and the webhook route).

```ts
DurableDashboardModule.forRoot({
  decorators: [UseGuards(AuthenticationGuard)], // runs first
  authorize: { policy: ConsolePolicy, ability: 'view' },
});
```

`authorize` takes a function `(ctx) => boolean | { allowed } | { redirectTo }`, an `@Injectable()` class implementing `ConsoleAuthorizer`, a lazy import of one, an `@nestjs/authorization` `{ policy, ability }`, or a gate name resolved by `@dudousxd/nestjs-authz`. `authorizeByToken({ token })` allows an `Authorization: Bearer` token. A denial answers `403 { error: 'forbidden' }` (an access-denied page for a browser navigation), an unauthenticated result `401 { error: 'unauthenticated' }`, and `{ redirectTo }` a `302` for a navigation or a `401` carrying `redirectTo` for an API call. The SPA follows that `redirectTo` and otherwise shows an access-denied screen. With `routes: false`, apply it to your own controllers with `@UseConsoleAuthorize()`.

**Breaking:** the production boot refusal is removed (`UNPROTECTED_CONSOLE_IN_PRODUCTION`, `DASHBOARD_PROTECTION_CHECK`), and `decorators` no longer counts as protection. Without `authorize`, the console is open outside production and answers `403` to every request with `NODE_ENV=production`; one warning is logged at boot. Move the access check from `decorators` to `authorize` (for example `Can(ConsolePolicy, 'view')` becomes `authorize: { policy: ConsolePolicy, ability: 'view' }`). The mounted controllers are now always per-registration subclasses, so `app.get(DurableApiController)` no longer finds the mounted instance.
