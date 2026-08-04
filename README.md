# NovaGPT

One chat interface over many AI providers, with the routing between them as the
product rather than an implementation detail. When a provider is out of quota,
rate limited, or simply down, the request moves to one that is not — and the
user is told what happened rather than shown an error.

**Runs at zero cost.** Eight providers, all with free tiers, and a router that
treats quota as the scarce resource it is.

## Quick start

```bash
docker compose up
```

That is the whole setup. The stack comes up with **no provider keys at all** —
a mock adapter serves scripted responses so chat works end to end while you
decide which providers to sign up for. Add real keys to `Backend/.env` as you
get them; a provider is enabled by having a credential, not by being listed
anywhere.

Without Docker:

```bash
cd Backend && npm ci && npm run dev     # needs a MongoDB on :27017
cd Frontend && npm ci && npm run dev
```

Open http://localhost:5173, create an account — **the first account is the
administrator** — and send a message.

## What is interesting here

| | |
|---|---|
| **Routing is a ranking problem** | Health, operator priority, tier, measured latency, cost band, capability fit — applied lexicographically, so every decision is explainable and none of them is a weighted average nobody can reason about ([04](docs/backend/04-router.md)) |
| **Failover is never silent** | A switch is reported to the client mid-stream, before the new model's tokens, so two models never appear to continue each other's sentences ([07](docs/backend/07-streaming-engine.md)) |
| **The context engine is deterministic** | Five trimming stages, no LLM in the loop. A summary cannot hallucinate because nothing generates it ([06](docs/backend/06-context-engine.md)) |
| **Adding a provider is two steps** | Write an adapter, register it. The shared contract suite is what makes that claim checkable rather than aspirational ([03](docs/backend/03-provider-system.md)) |
| **Errors carry a trace id** | The cheapest support tool in the system: it turns "something went wrong" into one log query ([11](docs/backend/11-observability.md)) |

## The documentation is the point

`docs/backend/` is a handbook, not a reference. Every decision states what was
chosen, what was rejected, and **why** — including the ones that turned out to
be wrong and were amended during implementation. Those amendments are marked as
such rather than quietly rewritten.

Start with [01 — System overview](docs/backend/01-system-overview.md), then
[02 — Architecture](docs/backend/02-architecture.md). The twenty-five ADRs in
[15 — Decisions](docs/backend/15-decisions.md) are where the arguments live.

## Layout

```
Backend/      Hexagonal: domain · application · infrastructure · interfaces
Frontend/     React, Vite
docs/backend/ The handbook
ops/          Dashboards, alert rules, runbooks, deploy scripts, backups
```

## Testing

```bash
cd Backend
npm test              # unit, contract, integration, e2e — seconds
npm run test:load     # the five load scenarios
npm run test:chaos    # the five chaos exercises
```

The chaos exercises are automated rather than quarterly, because a quarterly
exercise is one that gets skipped in a busy quarter — and that is the quarter
the behaviour regressed.

## Status

Phases 0–10 delivered: platform, provider framework, routing, context,
streaming, eight adapters, chat, security, observability, hardening. See
[14 — Roadmap](docs/backend/14-roadmap.md) for what each phase found, including
the defects the tests caught before they shipped.

**Not yet done, stated plainly:** the eight adapters have never made a call to a
real provider endpoint — they are covered by a shared contract suite against
mocked HTTP, and live verification is the remaining gate before any of them is
production-supported.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md). Adding a provider takes about an hour and
the path is documented.

## Licence

ISC.
