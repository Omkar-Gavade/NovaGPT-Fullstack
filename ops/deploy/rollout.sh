#!/usr/bin/env bash
# Roll an image out and wait for it to be healthy.
#
# Kubernetes here because it is the most demanding target. Swap the two `kubectl`
# lines for the equivalent on any other runtime — nothing above this script
# assumes an orchestrator (docs/backend/13-deployment.md#deployment-philosophy).
#
#   ./rollout.sh production ghcr.io/novagpt/backend@sha256:...
set -euo pipefail

ENVIRONMENT="${1:?usage: rollout.sh <environment> <image>}"
IMAGE="${2:?usage: rollout.sh <environment> <image>}"
NAMESPACE="novagpt-${ENVIRONMENT}"

echo "Rolling $NAMESPACE to $IMAGE"

kubectl -n "$NAMESPACE" set image deployment/novagpt-api "api=$IMAGE" --record

# Bounded. Without a timeout a stuck rollout hangs the pipeline until the job
# limit kills it, which loses the log that would have said why.
#
# `maxUnavailable: 0` means the old pods keep serving throughout, so a failure
# here is a rollout that never completed rather than an outage — and the caller
# rolls back to a version that is still running.
if ! kubectl -n "$NAMESPACE" rollout status deployment/novagpt-api --timeout=10m; then
  echo "::error::Rollout did not complete within 10 minutes"
  kubectl -n "$NAMESPACE" describe deployment/novagpt-api | tail -30
  exit 1
fi

echo "Rollout complete."
