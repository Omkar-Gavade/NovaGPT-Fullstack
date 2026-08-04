# Runbook — Roll back a deploy

**Not an alert.** The pipeline rolls back automatically when the production
smoke test fails. This is for the case it does not catch: a deploy that passes
its checks and is *then* found to be bad.

## Decide fast, diagnose later

If the error rate, latency or failover rate moved at a deploy, roll back **first**.
A rollback takes two minutes and a diagnosis takes twenty; doing them in the
other order means the users are experiencing the diagnosis.

## Find what was running

```bash
kubectl -n novagpt-production rollout history deployment/novagpt-api
```

Roll back by **digest**, never by tag. `latest` after a bad deploy points at the
broken build, so a tag-based rollback redeploys exactly what you are trying to
remove.

```bash
kubectl -n novagpt-production rollout undo deployment/novagpt-api
kubectl -n novagpt-production rollout status deployment/novagpt-api --timeout=10m
ops/deploy/smoke.sh https://api.novagpt.example
```

## What a rollback does not undo

| Change | Reversible by rollback? |
|---|---|
| Application code | Yes |
| Configuration in the ConfigMap | **No** — it is a separate object; revert it explicitly |
| A database migration | **No.** Check whether the deploy ran one *before* rolling back |
| Data already written in the new shape | **No** |

A rollback across a schema change is how a bad deploy becomes a data incident.
If the deploy migrated anything, stop and read the migration first.

## Verify recovery

Smoke test green, and the metric that triggered the rollback returns to its
pre-deploy level. Confirm the *old* digest is what is running:

```bash
ops/deploy/current-digest.sh production
```

## Afterwards

The build that failed is still tagged and still published. Either fix forward or
explicitly revert the commit — a broken `latest` left in the registry is what
the next deploy will build on top of.
