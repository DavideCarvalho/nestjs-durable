---
"@dudousxd/nestjs-durable-dashboard": patch
---

Dashboard polish: kill two layout shifts. The Workers panel toggle now swaps views inside a
fixed-width, right-justified slot (`flex-nowrap`), so switching between pods/parts/alerts no longer
wraps the header onto a second line or jumps its width. The runs list shows a skeleton while the
first `/runs` fetch is in flight instead of flashing "No runs yet." before real data lands.
