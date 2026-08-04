# Runbook — NovaAllProvidersUnavailable

**Severity:** page · **Alert:** `nova_routing_candidates` p50 = 0 for 2 minutes

## What it means

Routing found **zero eligible models**. Every chat request is failing with
`provider_unavailable`. This is the one provider-related condition that pages,
because the whole architecture exists so a single provider going down is a
non-event — zero candidates means that design has run out of room.

## Confirm it

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://$HOST/api/v1/admin/metrics | grep -E 'nova_provider_(health|breaker_state)'
```

Every provider at `breaker_state 1` confirms it. Then read one failing trace —
`routing.decide` carries `routing.candidates`, and the log event
`routing.exhausted` carries the reason.

## Likely causes, in the order they actually happen

| Cause | Tell | Action |
|---|---|---|
| **Every key expired or was rotated** | `nova_routing_retries_total{kind="auth"}` climbing across *all* providers | Rotate keys. See [platform-key-rejected](platform-key-rejected.md) |
| **Daily free-tier quotas exhausted simultaneously** | `kind="quota"`, and it is near a UTC day boundary | Quotas reset on their own. Consider enabling a paid provider as a floor |
| **Outbound network is blocked** | Every provider failed at once with `outage`, and probes time out | Check egress rules and DNS from inside the container |
| **A bad deploy disabled the fleet** | `PROVIDERS_ENABLED`/`PROVIDERS_DISABLED` changed in the last deploy | Roll back |

## Fix

1. If the cause is credentials, rotate and restart. Two keys are supported
   concurrently, so a rotation is a zero-downtime shift.
2. If the cause is quota, there is nothing to do but wait for the reset — say so
   on the status page rather than restarting things.
3. If a deploy is implicated, roll back first and investigate afterwards.

## Verify recovery

`nova_routing_candidates` returns above zero and `nova_requests_total{status="5.."}`
stops climbing. Send one real request; do not close the incident on metrics alone.

## If it recurs

Recurring exhaustion means the fleet is too small for the load. That is a
capacity decision, not an incident: add a provider, or add a paid fallback.
