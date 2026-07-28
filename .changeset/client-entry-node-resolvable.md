---
'@dudousxd/nestjs-durable-dashboard': patch
---

**Fix: the `./client` subpath could not be imported outside a bundler.**

`src/client` is compiled with `moduleResolution: 'Bundler'`, which allows extensionless relative
imports and emits them verbatim — so `dist/client/durable-client.js` shipped
`from './group-subprocesses'` and Node's ESM resolver threw `ERR_MODULE_NOT_FOUND` on it. A bundler
(Vite, webpack) papered over it, so the entry appeared to work everywhere it had been used; anything
resolving with real Node semantics — SSR, a vitest suite that doesn't pre-bundle, a plain script —
could not import it at all.

That matters more now than it did: `./client` is where the headless console launcher
(`openDurableConsole`) lives, and the whole point of a headless primitive is that it works outside a
browser bundle.

Relative imports under `src/client` now carry explicit `.js` extensions. No API change; the built
output is otherwise identical. Verified by importing the built entry from Node directly.
