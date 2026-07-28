---
'@dudousxd/nestjs-durable-dashboard': minor
---

**A React tier at the new `./react` subpath — so the console launcher has all three levels, not just the headless one.**

`@dudousxd/nestjs-durable-dashboard` had no React surface at all (unlike telescope's `./react`,
`nestjs-media-react` and `nestjs-agent-react`), so a host wiring a launcher had to build the UI from
scratch even though every host builds the same one. Now:

| Level | Import | You own |
|---|---|---|
| headless | `openDurableConsole` from `./client` | everything |
| hook | `useOpenDurableConsole()` from `./react` | the markup |
| drop-in | `<OpenDurableConsoleButton />` from `./react` | nothing |

```tsx
import { OpenDurableConsoleButton } from '@dudousxd/nestjs-durable-dashboard/react';

<OpenDurableConsoleButton className="btn btn-primary" headers={() => authHeaders()} />;
```

The button is **unstyled** and forwards `className`/`style`/every other button prop, so it inherits
the host's design system rather than importing CSS that would fight it. It renders the refusal by
default (a launcher that silently does nothing reads as broken rather than forbidden); pass
`renderError` to render your own node, or `renderError={null}` to opt out. It disables itself while
in flight so a double-click cannot fire a second mint that lands after the navigation.

`openDurableConsoleMutationOptions()` gives **TanStack Query integration without a TanStack
dependency**: it returns the object `useMutation` takes, so a host already using Query gets the
launcher in its cache, devtools and error handling, and a host that isn't pays nothing.

React and react-dom are **optional** peer dependencies, and the React code lives behind its own
subpath — a host that only mounts the NestJS module never pulls React in.

Also widens the repo's vitest `include` to `.tsx`: the `.ts`-only glob silently collected no specs
for these components.
