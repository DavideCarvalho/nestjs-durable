---
'@dudousxd/nestjs-durable-core': patch
---

Read cron schedules through either cron-parser major, not only v4

`cron-parser` is declared as an optional peer at `^4.0.0 || ^5.0.0`, but `prevCronFireMs`
only ever called v4's entry point. The two majors do not share one: v4 exports
`parseExpression`, v5 replaced it with `CronExpressionParser.parse`. Every v5 install
therefore failed the moment a cron schedule was evaluated:

```
parser.parseExpression is not a function
```

which reads as a missing dependency rather than as the wrong major — and since the
scheduler probes cron at boot, the symptom was "no connector will run on a schedule" with
nothing obviously wrong in the install.

The cause was the type: `typeof import('cron-parser')` pins the module to whichever major
is dev-installed, so the *other* major's entry point is a compile error and can never be
called. The module is now typed `unknown` and narrowed by runtime guards in a new
`cron-compat.ts`, which picks v4's or v5's entry point and unwraps an ESM `default`
namespace. Note that v4's CommonJS export is a *function* carrying `parseExpression`, not
an object, so the guard admits both.

Only one major can be installed at a time, so the existing suite can never exercise both:
`cron-compat.spec.ts` pins the entry-point selection against fake module shapes instead.
The scheduler suite passes against 4.9.0 and 5.5.0 alike, and now throws a message naming
the supported range if a module presents neither entry point.
