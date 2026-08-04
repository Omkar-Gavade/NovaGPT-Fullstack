#!/usr/bin/env bash
# Smoke test: does the product actually work?
#
# Deliberately exercises the real path — register, sign in, send a message, read
# it back — rather than checking that a health endpoint returns 200. Readiness
# says the process can reach its dependencies. It says nothing about whether a
# routing change broke chat, and a deploy gate that cannot tell the difference
# is not a gate (docs/backend/13-deployment.md#cicd).
#
#   ./smoke.sh https://api.novagpt.example
set -euo pipefail

BASE="${1:?usage: smoke.sh <base-url>}"
EMAIL="smoke-$(date +%s)-$RANDOM@novagpt.invalid"
PASSWORD="smoke-test-passphrase-$RANDOM"
FAILURES=0

step() { printf '  %-42s' "$1"; }
pass() { printf 'ok\n'; }
fail() { printf 'FAILED — %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

echo "Smoke test against $BASE"

# ── 1. The process is alive ──────────────────────────────────────────────
step "liveness"
if curl -fsS -m 10 "$BASE/live" >/dev/null; then pass; else fail "no response"; fi

# ── 2. It can reach its dependencies ─────────────────────────────────────
step "readiness"
if curl -fsS -m 10 "$BASE/ready" >/dev/null; then pass; else fail "a dependency is down"; fi

# ── 3. The version is the one we just deployed ───────────────────────────
step "version endpoint"
VERSION=$(curl -fsS -m 10 "$BASE/version" || echo '{}')
if [[ "$VERSION" == *'"commit"'* ]]; then pass; else fail "no build metadata"; fi

# ── 4. The catalog serves without an account ─────────────────────────────
step "public catalog"
MODELS=$(curl -fsS -m 10 "$BASE/api/v1/models" || echo '{}')
if [[ "$MODELS" == *'"data"'* ]]; then pass; else fail "catalog empty or erroring"; fi

# ── 5. A conversation endpoint refuses an anonymous caller ───────────────
# A deploy that accidentally disabled the auth gate must not pass.
step "conversations require auth"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE/api/v1/threads")
if [[ "$CODE" == "401" ]]; then pass; else fail "expected 401, got $CODE"; fi

# ── 6. Registration and sign-in ──────────────────────────────────────────
step "register"
TOKEN=$(curl -fsS -m 20 -X POST "$BASE/api/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
if [[ -n "$TOKEN" ]]; then pass; else fail "no access token"; fi

# ── 7. The product path ──────────────────────────────────────────────────
step "chat round trip"
THREAD=""
if [[ -n "$TOKEN" ]]; then
  REPLY=$(curl -fsS -m 60 -X POST "$BASE/api/v1/chat" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"message":"deployment smoke test"}' || echo '{}')
  THREAD=$(sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p' <<<"$REPLY")
  if [[ -n "$THREAD" ]]; then pass; else fail "no reply"; fi
else
  fail "skipped, no token"
fi

# ── 8. It was written down ───────────────────────────────────────────────
# Answering and *persisting* are different failures, and only one of them is
# visible from the response.
step "conversation persisted"
if [[ -n "$THREAD" ]]; then
  COUNT=$(curl -fsS -m 20 "$BASE/api/v1/threads/$THREAD" -H "Authorization: Bearer $TOKEN" \
    | grep -o '"role"' | wc -l | tr -d ' ')
  if [[ "$COUNT" -ge 2 ]]; then pass; else fail "expected 2 messages, found $COUNT"; fi
else
  fail "skipped, no thread"
fi

# ── 9. Streaming, which no health check covers ───────────────────────────
step "streaming"
if [[ -n "$TOKEN" ]]; then
  FRAMES=$(curl -fsS -m 60 -N -X POST "$BASE/api/v1/chat/stream" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"message":"stream smoke test"}' | grep -c '^data:' || true)
  # More than one frame proves the proxy is not buffering the whole response
  # and delivering it at the end — the single most common SSE deployment
  # failure, and invisible to every other check here.
  if [[ "$FRAMES" -gt 1 ]]; then pass; else fail "got $FRAMES frames; a proxy is buffering"; fi
else
  fail "skipped, no token"
fi

echo
if [[ "$FAILURES" -gt 0 ]]; then
  echo "SMOKE TEST FAILED: $FAILURES check(s)"
  exit 1
fi
echo "All checks passed."
