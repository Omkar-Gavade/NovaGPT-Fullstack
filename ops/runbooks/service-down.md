# Runbook — NovaServiceDown

**Severity:** page · **Alert:** `up{job="novagpt"} == 0` for 2 minutes

## What it means

No instance answered a scrape for two minutes. Either the process is gone, or it
is alive and too wedged to serve — including the health endpoint.

## Confirm it

```bash
curl -sS -m 5 https://$HOST/live && echo && curl -sS -m 5 https://$HOST/ready
```

`/live` answering while `/ready` does not is a **dependency** problem, not an
outage — go to [database-unreachable](database-unreachable.md) instead.

## Likely causes

| Cause | Tell |
|---|---|
| **Crash loop** | The orchestrator shows restarts; boot logs end at `boot.starting` |
| **Bad configuration** | `ConfigError` at boot naming a variable. Common after a deploy that added one |
| **Event loop saturated** | The process is up, CPU is pinned, `nodejs_eventloop_lag_seconds` was climbing before the scrape stopped |
| **OOM kill** | Exit code 137 |

## Fix

1. Read the last 50 lines before the process died. A `ConfigError` names the
   variable and never prints its value — fix and redeploy.
2. Crash loop with no clear cause: roll back to the previous image. Diagnose
   from the artefact, not from production.
3. Event-loop saturation: scale out. Rising lag means *every* request is
   slowing, including the health check, which is how an instance ends up marked
   healthy while serving nothing.

## Verify recovery

`/ready` returns 200, and a real chat request completes. Confirm the instance is
back in the load balancer.
