# Runbook — NovaAuthFailureSpike

**Severity:** warning · **Alert:** sustained sign-in failures for 10 minutes

## What it means

More failed sign-ins than normal. Most often a credential-stuffing run (T9);
occasionally a broken client retrying a bad password in a loop.

**Do not page on this.** The defences are already working: per-IP limits fail
closed, and account lockout escalates. This is a notification that they are
being exercised.

## Confirm it

The audit log is the source of truth — every outcome is recorded, including the
failures:

```
action = "auth.login", outcome = "failure"
```

Group by `actorIp`. One IP against many accounts is stuffing. Many IPs against
one account is targeted. One IP against one account is a stuck client.

## Fix

| Shape | Action |
|---|---|
| One IP, many accounts | Block at the ingress. The per-IP limit is already refusing them; blocking upstream stops them consuming capacity |
| Many IPs, one account | Notify the account owner. Consider forcing a password reset |
| One IP, one account | Almost always a misconfigured client. Contact the user before blocking |

Lowering `RATE_LIMIT_AUTH_PER_MINUTE` is a legitimate temporary response.

## Verify recovery

The rate returns to baseline. Check the audit log for any `outcome: "success"`
from the same IP — a stuffing run that *succeeded* is a different incident, and
that account's sessions should be revoked.
