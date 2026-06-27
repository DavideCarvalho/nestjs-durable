---
"@dudousxd/nestjs-durable-telescope": patch
---

Rename the Workflows dashboard "Starved worker groups" panel to "Worker health".
The panel lists ALL worker groups (starved sorted first) with a Status column that
flags STARVED only when a group has queued work and zero live workers — the old
title read as if every listed group were starved.
