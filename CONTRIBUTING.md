# Contributing

## Setting up

```bash
docker compose up
```

No provider keys required. The mock adapter makes no network calls and serves
scripted responses, so the whole product works before you have signed up for
anything — that property is deliberate and worth preserving.

## The one rule that is not negotiable

**Dependencies point inward.**

```
interfaces → application → domain
infrastructure → domain
```

`domain/` imports nothing from the other three. Not "should not" — CI fails on
it. The domain is where every rule that is expensive to get wrong lives, and it
stays testable in milliseconds precisely because nothing in it can reach a
socket ([02](docs/backend/02-architecture.md)).

If a change seems to require the domain to know about Mongo or Express, the
missing piece is a port. Add the interface to `domain/ports/`.

## Adding a provider

The claim is that this takes an hour. The path:

1. **Write the adapter** in `Backend/src/infrastructure/providers/adapters/<id>/index.js`.
   If the provider speaks the OpenAI dialect — most do — extend
   `OpenAIDialectProvider` and you are writing a descriptor, not a client.
2. **Declare its models** in the descriptor: context window, capabilities, cost
   band, tier. Capabilities are what the router matches against, so a wrong
   declaration produces misrouting rather than an error.
3. **Add prices** to `CostTable` with an `effectiveFrom` date. A model with no
   entry records `null` cost, which is honest but shows up in the quarterly
   audit ([ADR-025](docs/backend/15-decisions.md#adr-025--an-unpriced-model-costs-null-not-zero)).
4. **Run the contract suite.** It runs against every adapter automatically.

That is the whole list. Discovery finds the directory, the factory builds it if a
credential is present, and nothing else needs editing — a registration list you
have to remember to update is a list someone eventually does not.

### The contract suite is not optional

The router's correctness is a **fleet** property. It assumes every adapter maps
a quota response to `quota`, cancels within 100 ms, and buffers split SSE
frames. One adapter getting any of those wrong breaks routing in a way that
looks like a router bug
([ADR-020](docs/backend/15-decisions.md#adr-020--a-shared-contract-test-suite-for-every-adapter)).

## Tests

```bash
npm test              # unit, contract, integration, e2e
npm run test:load     # memory and lag under the documented load profiles
npm run test:chaos    # the five chaos exercises
```

**Every bug gets a test before it gets a fix, and the test must fail against the
unfixed code.** A test written after the fix proves the code passes; it proves
nothing about whether it reproduces the bug.

What a good test looks like here: the name states the behaviour, and a comment
states what breaks without it. `test("archived=false lists active threads")`
with a comment explaining that `z.coerce.boolean()` reads `"false"` as `true` is
worth more than three assertions with no explanation.

## Changing a documented decision

The handbook in `docs/backend/` is treated as decided. To change one:

1. Amend the document **first**, in the same pull request.
2. Record the reasoning in [15 — Decisions](docs/backend/15-decisions.md).
3. Then change the code.

A pull request whose behaviour contradicts a document without updating it is the
thing that makes handbooks stop being trustworthy — and once they are not, they
stop being read.

Where implementation showed a documented decision was wrong, the document says
so under **"Amended during implementation"** rather than being quietly
rewritten. The reasoning that turned out to be wrong is often more useful than
the correction.

## Adding a dependency

Justify it in the pull request, in one line. Every dependency is code we ship
and cannot audit, and the supply chain has the worst effort-to-impact ratio
available to an attacker. Two things in this repository are hand-written for
exactly that reason — the JWT codec and the tracer — and both ADRs
([021](docs/backend/15-decisions.md#adr-021--the-jwt-codec-and-the-cookie-codec-are-written-here-not-imported),
[024](docs/backend/15-decisions.md#adr-024--tracing-is-collected-in-process-not-through-an-opentelemetry-sdk))
also say when to revisit that call.

A one-line justification is a small tax. It is aimed at the
transitive-dependency-heavy package added to save fifteen lines.

## Style

Match the surrounding code. The one convention worth naming: **comments explain
why, never what.** `// increment the counter` is noise. `// Not unref'd: the
drain must hold the event loop open, or Node exits mid-shutdown` is the comment
that stops someone re-introducing a bug that has already been fixed once.

## Security

Do not open an issue for a vulnerability. See [SECURITY.md](SECURITY.md).
