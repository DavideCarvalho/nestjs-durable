---
"@dudousxd/nestjs-durable-dashboard": minor
---

The `ctx.webhook()` callback route (`POST <apiBasePath>/webhooks/:token`) is no longer gated by the console's `authorize`: a third party cannot sign in, and the token in the URL is the secret. A production app with no `authorize` now receives webhook callbacks while its console answers `403`. The guards in `decorators` still apply to the route, and a self-mounted API controller with `@UseConsoleAuthorize()` leaves its inherited webhook route open the same way.
