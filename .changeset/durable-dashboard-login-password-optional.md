---
'@dudousxd/nestjs-durable-dashboard': patch
---

Fix the built-in `dashboardAuth` login page so **password is optional end-to-end**, matching the
`login` hook's own contract: the password `<input>` no longer carries HTML `required`, and the
page forwards it to `POST <basePath>/login` verbatim — including an empty string when left blank
— so the `login` hook (not the page) decides whether a password matters. This unblocks hosts that
gate on username/email alone (e.g. any active admin, password ignored): previously the browser's
own `required` validation blocked the empty submission before it ever reached the hook.

Also restyled the login page to visually match `@dudousxd/nestjs-agent`'s dashboard login screen
(dark zinc card, mono type, emerald accent) so the two consoles read as one family. The page keeps
its own JSON `fetch` submit flow (this dashboard's `POST /login` returns a JSON `redirectTo` rather
than issuing a server redirect) and its title, `Sign in — Durable`, is unchanged.
