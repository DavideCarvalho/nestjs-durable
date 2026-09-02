---
'@dudousxd/nestjs-durable-dashboard': patch
---

Require the filter release that makes the console's own URLs parse

The console sends its predicates as bracket notation on a GET
(`filter[where][0][field]=tag`). Express 5 changed its default `query parser` to `simple`, which
leaves those as literal flat keys — so on NestJS 12 every predicate was dropped in silence: the run
list answered 200 with every run, unfiltered, and the value pickers came back empty. Fixed in
`@dudousxd/nestjs-filter@1.32.1`, which this package now requires.

The dashboard's own tests all passed while that shipped, because each covered one hop: the client
building a query string, or the controller receiving an already-parsed object. Nothing exercised an
HTTP layer parsing the one into the other. A new spec boots the console on a real server — with the
query parser left at its DEFAULT, since a host should not have to configure one — drives it with the
URLs its own client builds, and asserts the `RunQuery` the gateway receives.
