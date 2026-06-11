#!/usr/bin/env bash
# Cross-language end-to-end: a TypeScript workflow's remote step is handled by a Python worker
# over BullMQ/Redis. Proves "one workflow, steps split across languages".
#
# Requires: a Redis on 127.0.0.1:6379 and `pip install bullmq`.
#   ./scripts/py-e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm --filter @dudousxd/nestjs-durable-core --filter @dudousxd/nestjs-durable-transport-bullmq build >/dev/null

prefix="pye2e-$(date +%s)"
PYTHONPATH=clients/python python3 clients/python/examples/run_worker.py "$prefix" >/tmp/durable-pyworker.log 2>&1 &
PYPID=$!
trap 'kill $PYPID 2>/dev/null || true' EXIT
sleep 3  # let the Python worker connect and start consuming

node scripts/py-e2e-dispatch.mjs "$prefix"
echo "✓ cross-language workflow completed (TS engine → BullMQ/Redis → Python worker → back)"
