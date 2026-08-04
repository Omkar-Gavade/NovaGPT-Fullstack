# NovaGPT backend.
#
# Multi-stage so build tooling and dev dependencies never reach the runtime
# image — they are attack surface that ships to production for no benefit
# (docs/backend/13-deployment.md#container-design).
#
# **Build from the repository root**, not from `Backend/`:
#
#   docker build -f Backend/Dockerfile -t novagpt-backend .
#
# The test suite reads `ops/` — the alerting and metric-catalogue guards assert
# that every rule and panel references a metric that exists — and Docker cannot
# copy from outside the build context. A context that excluded `ops/` would mean
# the image is verified by a *subset* of the suite, which is the kind of gap
# nobody notices until the check it skipped was the one that mattered.

# ── Stage 1: dependencies ────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Only the manifests, so this layer caches across every source change. Copying
# the source first would reinstall on every commit.
COPY Backend/package.json Backend/package-lock.json ./

# `ci` rather than `install`: it fails when the lockfile and the manifest
# disagree, which is exactly the state a dependency-confusion attack produces.
# `--omit=dev` keeps the test runner and its tree out of the runtime image.
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 2: verification ────────────────────────────────────────────────
# Runs the full suite against the *same* lockfile the runtime layer installed.
# A green pipeline that tested different dependencies from the ones shipped is
# not a green pipeline.
FROM node:22-alpine AS verify
WORKDIR /app
COPY Backend/package.json Backend/package-lock.json ./
RUN npm ci
COPY Backend/src ./src
COPY Backend/test ./test
COPY ops ../ops
RUN npm test

# ── Stage 3: runtime ─────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Reaps zombies and forwards signals correctly. Node as PID 1 does neither,
# which produces containers that ignore SIGTERM and get SIGKILLed — killing
# every in-flight stream instead of draining them.
RUN apk add --no-cache tini

WORKDIR /app

# The `node` user ships with the base image. A container escape then starts from
# an unprivileged account: free to do here, expensive to retrofit later.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node Backend/package.json ./
COPY --chown=node:node Backend/src ./src

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

# `/live` and not `/ready`: a container whose *dependency* is down is degraded,
# not dead, and restarting it would neither fix the dependency nor help anyone
# (docs/backend/13-deployment.md#degradation-matrix).
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/main.js"]

# The application writes nothing to disk, so the root filesystem can be mounted
# read-only. That is a runtime flag rather than an image property, and every
# manifest in ops/ sets it — it blocks a whole class of persistence attacks.
