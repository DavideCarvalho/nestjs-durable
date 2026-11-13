---
"@dudousxd/nestjs-durable-dashboard": minor
---

Global search across the Aviary consoles. With another console mounted, Ctrl/Cmd+K (or "Search all
consoles" in the switcher menu) searches every console the viewer may open. Here it finds a run by id
and workflows by name. The endpoint is `GET <api>/consoles/search?q=`: 300 ms and 5 hits per console,
and `partial: true` when a console didn't answer in time. A registry entry can now carry
`search(context, q, limit)`.

While the switcher runs another console's `authorize` (or `search`), the request carries
`aviaryProbe: true`, so an authorizer that writes audit logs can skip those checks.
