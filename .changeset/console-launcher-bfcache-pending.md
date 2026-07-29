---
'@dudousxd/nestjs-durable-dashboard': patch
---

Fix the console launcher hanging on a spinner after the user presses Back.

`useOpenDurableConsole` leaves `isPending` set after a successful mint on purpose — the navigation to
the console is already underway, and going back to idle first flickers "ready to click again" on a
page that is leaving. That assumed the page is discarded, which the browser's back/forward cache
makes untrue: pressing Back restores the launcher page from memory with React state intact, so the
user returns to a spinner that never stops on a button that is `disabled` by that flag.

The hook now listens for `pageshow` and clears `isPending` only when `event.persisted` is true — the
signal browsers fire exclusively on a bfcache restore. An ordinary load and a mint that is genuinely
still in flight are both untouched, so the anti-flicker behaviour is unchanged. SSR-safe, and the
listener is removed on unmount.
