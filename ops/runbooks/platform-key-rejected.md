# Runbook — NovaPlatformKeyRejected

**Severity:** page · **Alert:** any `auth` failure against a platform key

## What it means

A provider rejected our credential. **Nothing recovers without a human** — this
is why it pages on the first occurrence rather than on a rate. The breaker opens
immediately on `auth` rather than after a threshold, so the provider is already
out of rotation and the fleet is one provider smaller.

## Confirm it

The log event `routing.failover` or `provider.failure` with `kind: auth` names
the provider. The metric is `nova_routing_retries_total{kind="auth"}`.

## Likely causes

| Cause | Tell |
|---|---|
| **Key revoked or expired** | Started abruptly, one provider only |
| **Key rotated in the secret manager but not deployed** | Coincides with a rotation window |
| **Account suspended for terms violation** | Provider dashboard says so; the key itself is valid |
| **Wrong environment's key** | Started at a deploy |

## Fix

1. Verify the key against the provider's own API before touching anything.
2. Rotate: add the new key, deploy, confirm recovery, then remove the old one.
   Two keys are supported concurrently precisely so this is a zero-downtime
   shift (docs/backend/10-security.md#rotation).
3. If the account is suspended, take the provider out with `PROVIDERS_DISABLED`
   rather than leaving it flapping.

## Verify recovery

The provider's breaker closes on its own within one health interval (60 s by
default) — the monitor probes only non-healthy providers, so recovery is
automatic once the key works.

**Never** paste a key into a log line, a ticket, or a chat message to check it.
