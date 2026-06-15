# @dudousxd/nestjs-durable-transport-db

## 1.0.0

### Patch Changes

- Updated dependencies [4762866]
- Updated dependencies [c648786]
- Updated dependencies [f1e7999]
- Updated dependencies [f1679e5]
- Updated dependencies [46c293b]
  - @dudousxd/nestjs-durable-core@1.0.0

## 0.1.1

### Patch Changes

- Carry `startedAt` through the SQL transport so queue-wait works over it too: the results table gains
  a nullable `started_at` column, written from the worker's pickup time and surfaced on the polled
  `StepResult`. Brings the DB transport in line with BullMQ/SQS (which already forwarded it) and with
  the Python `db_runner`. The column is added to the auto-created schema; an existing
  `*_transport_results` table from a prior release should be dropped (it's transient) so it picks up
  the new column.
