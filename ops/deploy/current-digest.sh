#!/usr/bin/env bash
# What is running right now, as a digest.
#
# Captured *before* a deploy so the rollback target is what was actually
# serving, not what a tag points at. Tags move; `latest` after a failed deploy
# points at the broken build, so rolling back to a tag would redeploy the thing
# that just failed.
set -euo pipefail

ENVIRONMENT="${1:?usage: current-digest.sh <environment>}"
NAMESPACE="novagpt-${ENVIRONMENT}"

# The *running* pod's resolved digest, not the deployment spec's image
# reference: the spec may name a tag, and the tag is exactly what cannot be
# trusted here.
kubectl -n "$NAMESPACE" get pods -l app=novagpt-api \
  -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="api")].imageID}' 2>/dev/null \
  | sed 's|^docker-pullable://||' || true
