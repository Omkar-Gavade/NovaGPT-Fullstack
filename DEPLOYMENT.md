# Deploying NovaGPT

The short version: one container, MongoDB, and at least one provider key.
Everything else has a working default.

## Before you start

Three things are enforced at boot in production, and the process **refuses to
start** without them rather than starting and behaving wrongly. A deployment
that runs and then rejects every login is far harder to diagnose than one that
says which variable is missing.

| Required in production | Why it is not optional |
|---|---|
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` | An ephemeral pair invalidates every token on restart and cannot be verified by a second instance |
| `AUTH_REQUIRED=true` | Off leaves every conversation endpoint open |
| `CORS_ORIGINS` set to real origins | A wildcard lets any site drive the API with a user's credentials |

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt.key
openssl rsa -pubout -in jwt.key -out jwt.pub
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # ENCRYPTION_MASTER_KEY
```

`ENCRYPTION_MASTER_KEY` is only needed for BYOK. Without it the feature refuses
rather than falling back — encrypting user credentials under a key that dies
with the process would be worse than not offering it.

## Local, in one command

```bash
docker compose up
```

The stack comes up with **no provider keys at all**: a mock adapter serves
scripted responses so chat works end to end while you decide which providers to
sign up for. That property is deliberate — a contributor sees a working system
before signing up for anything.

## Production

```bash
docker build -f Backend/Dockerfile -t novagpt-backend .
```

Build from the repository root, not `Backend/` — the test suite reads `ops/`,
and a context that excluded it would verify the image with a *subset* of the
suite.

The image runs as a non-root user with a read-only root filesystem and `tini` as
PID 1 (Node as PID 1 ignores `SIGTERM`, which means every in-flight stream is
killed instead of drained). `ops/deploy/kubernetes/` has manifests; nothing above
the container assumes an orchestrator.

### The load-balancer checklist

Every line here has produced the same user-visible symptom somewhere:
*"streaming doesn't work, the whole answer arrives at the end."*

- **Response buffering off.** The single most common SSE deployment failure.
- **No compression on `text/event-stream`.** It buffers to fill its window.
- **Idle timeout ≥ 300 s.** A long generation looks idle to a proxy watching for
  request activity.
- **`terminationGracePeriodSeconds` > `SHUTDOWN_GRACE_MS` + preStop.** Otherwise
  the orchestrator SIGKILLs mid-drain and cuts *every* stream instead of the
  stragglers.

`ops/deploy/smoke.sh` checks the first of these directly by counting SSE frames —
more than one proves nothing is buffering.

## Verifying a deployment

```bash
ops/deploy/smoke.sh https://your-host
```

Nine checks over the real product path — register, sign in, chat, read it back,
stream — rather than a health endpoint returning 200. Readiness says the process
can reach its dependencies; it says nothing about whether a routing change broke
chat.

## Providers

A provider is enabled by having its credential. Add any subset; the router uses
what is configured and routes around what is not. Ollama is the exception — it
has no credential, so `OLLAMA_BASE_URL` is its switch.

**Ship new providers dark.** `PROVIDERS_DARK=qwen,ollama` keeps them configured
and reachable but ranked last, so they receive traffic only as a late failover
while accumulating telemetry with a bounded blast radius. Promote by removing
them from the list once the gate is satisfied.

## Health

| Endpoint | Answers | Use for |
|---|---|---|
| `/live` | Is the process alive? | Container health check, liveness probe |
| `/ready` | Can it reach its dependencies? | Load-balancer membership, readiness probe |
| `/health` | Both, with detail | Humans |
| `/version` | Commit and build time | Confirming what is deployed |

**Liveness must not probe dependencies.** Restarting an instance because Mongo
blipped fixes nothing and drops every stream on it.

## Backups

`ops/backup/backup.sh` encrypts with a key separate from the database's own — a
backup readable by whoever compromised the database is a second copy of the
breach, not a backup. It then **restores into a scratch database and counts
rows** on every run, because a backup that has never been restored is a
hypothesis.

## Operations

Dashboards in `ops/grafana/`, alert rules in `ops/prometheus/alerts.yml`, and a
runbook per paging alert in `ops/runbooks/`. Every paging alert links one, and a
test fails if it does not.
