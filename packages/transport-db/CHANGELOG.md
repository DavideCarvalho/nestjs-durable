# @dudousxd/nestjs-durable-transport-db

## 0.1.1

### Patch Changes

- Carry `startedAt` through the SQL transport so queue-wait works over it too: the results table gains
  a nullable `started_at` column, written from the worker's pickup time and surfaced on the polled
  `StepResult`. Brings the DB transport in line with BullMQ/SQS (which already forwarded it) and with
  the Python `db_runner`. The column is added to the auto-created schema; an existing
  `*_transport_results` table from a prior release should be dropped (it's transient) so it picks up
  the new column.
