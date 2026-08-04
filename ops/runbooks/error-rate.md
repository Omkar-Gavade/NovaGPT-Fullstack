# Runbook — NovaErrorRateCritical

**Severity:** page · **Alert:** 5xx > 5% of requests for 5 minutes

## What it means

Widespread failure. Unlike the provider alerts, this says nothing about *why* —
it is a symptom alert, which is the point: it fires for causes nobody
anticipated.

## Confirm and narrow, in this order

1. **Which route?** `sum by (route) (rate(nova_requests_total{status=~"5.."}[5m]))`
2. **Which kind?** `sum by (kind) (rate(nova_request_errors_total[5m]))` — the
   kind maps directly to a cause:
   - `provider_unavailable` → [all-providers-unavailable](all-providers-unavailable.md)
   - `timeout` → a provider is slow; check `nova_provider_attempt_duration_seconds`
   - `internal` → a defect. Take a trace id from any error response.
3. **One trace.** Every error response carries a `traceId`. Errors are sampled at
   100%, so the trace exists — search the logs for `trace.sampled` with that id
   and read the span tree.

## Fix

There is no generic fix. The narrowing above lands on one of the other runbooks,
or on a code defect — in which case roll back if the error rate started at a
deploy, and diagnose from the trace afterwards.

## Verify recovery

The ratio falls below 1% and stays there for 10 minutes.
