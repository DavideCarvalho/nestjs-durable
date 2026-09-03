---
'@dudousxd/nestjs-durable-dashboard': patch
---

`useOpenDurableConsole` stops sticking on `isPending` when the caller navigates

The launcher left `isPending` set after a successful mint, on the reasoning that the navigation was
underway and the page was about to be torn down — flipping the button back to idle first shows a
flicker of "ready to click again" on a document that is leaving.

That reasoning only holds for the DEFAULT navigation. `OpenConsoleOptions.navigate` is documented as
the way to "route through your own router, **or to open in a new tab**" — and a new tab leaves the
launcher page exactly where it was, on screen, with a button now `disabled` forever. The launcher
worked once per page load; a reload was the only way back.

Success now clears the flag when the caller supplied a `navigate`, and keeps today's behaviour (and
the anti-flicker guarantee, plus its `pageshow` counterpart for a back/forward-cache restore) for the
default. The pinned anti-flicker test now exercises the default navigation, which is the case it was
always about.
