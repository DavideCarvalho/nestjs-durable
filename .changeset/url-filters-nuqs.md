---
"@dudousxd/nestjs-durable-dashboard": minor
---

The Runs board's filters now live in the URL, so a filtered view can be shared, bookmarked and reloaded, and Back/Forward step through it: status, tag, namespace, attribute predicates and origin sit in the hash's query (`#?status=failed&tag=vip`, `#/run/<id>?status=failed`), read and written with nuqs through the console kit's hash adapter. A value at its default is left out, so existing `#/run/<id>` links open as before, and the filters still survive a trip to Workers and back.
