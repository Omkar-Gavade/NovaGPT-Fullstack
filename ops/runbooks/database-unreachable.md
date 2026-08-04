# Runbook — NovaDatabaseUnreachable

**Severity:** page · **Alert:** `nova_dependency_up{dependency="mongodb"} == 0` for 2 minutes

## What it means

Conversations cannot be read or written. **The catalog keeps serving** and the
process stays up — the connection is established in the background and never
blocks startup, so a database outage is a degradation rather than a total
outage (docs/backend/13-deployment.md#degradation-matrix).

Users see a clear "storage temporarily unavailable" error on chat, not a hang.
That is the designed behaviour, and it is why this pages at 2 minutes rather
than instantly.

## Confirm it

`/ready` reports the failing dependency by name. `mongo.connect_failed` in the
logs carries the attempt count and the backoff.

## Likely causes

| Cause | Tell |
|---|---|
| **Replica set has no primary** | Election in progress; recovers on its own within seconds |
| **Credentials rotated without a deploy** | Authentication failures in the driver logs |
| **Connection pool exhausted** | Reachable but every operation times out. `MONGO_MAX_POOL_SIZE` too low for the instance count |
| **Network policy change** | Started exactly at a deploy of something else |

## Fix

1. Check the cluster's own health first. Most causes are on that side, and the
   application retries with capped backoff without intervention.
2. If credentials rotated, redeploy with the new `MONGODB_URI`.
3. Do **not** restart the application to "reconnect" — it is already retrying,
   and a restart drops in-flight streams for no gain.

## Verify recovery

`mongo.connected` appears in the logs, `/ready` returns 200, and one send-then-read
round trip works.
