# Runbook — Under load, shedding traffic

**Not an alert on its own.** Reach for this when latency and event-loop lag are
climbing together and scaling out is not fast enough.

## Confirm it is load and not a defect

Load looks like: event-loop lag climbing, `nova_active_streams` at or above ~200
per instance, latency up across *every* route including the cached catalog.

A defect looks like: one route slow, the rest fine. Do not shed for that — find
the route.

## In order of preference

**1. Scale out.** The application is stateless and the HPA should already be
doing this. If it is not, the metric it scales on is missing — check that
`nova_active_streams` is reaching the adapter.

**2. Tighten the per-user chat limit.** Costs the heaviest users first, which is
usually the fair order, and takes effect on the next request:

```bash
kubectl -n novagpt-production set env deployment/novagpt-api RATE_LIMIT_CHAT_PER_MINUTE=8
```

**3. Tighten the anonymous limit.** Protects signed-in users at the expense of
the landing page.

**4. Close registration.** `AUTH_ALLOW_REGISTRATION=false`. Stops the growth
without touching anyone already using the product.

## What not to do

**Do not restart instances to "clear" load.** Every restart cuts the streams on
that instance and pushes their users into an immediate retry — which adds load
at the moment you are trying to remove it.

**Do not raise the limits to make the 429s stop.** The 429s are the system
working. The alert to watch is latency, not refusals.

## Verify recovery

Event-loop lag p99 back under 100 ms and latency back to baseline. Then **put
the limits back** — a temporary limit nobody reverted is a permanent product
regression that no one remembers choosing. Note the change and its expiry in the
incident record.
