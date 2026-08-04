# 15 — Architecture Decision Records

## How to use this document

Every architecturally significant decision is recorded here with the problem, the
options considered, what was chosen, why, what it costs, and what it constrains
in the future.

**A decision is architecturally significant if reversing it later would be
expensive.** Choosing a logging library is not significant; choosing the
dependency direction between layers is.

**The rules:**

- An ADR is **immutable once accepted**. New information produces a *new* ADR
  that supersedes the old one; the old one stays, marked superseded. A record of
  what we believed and why is more valuable than a record that only shows the
  current answer.
- **Record the decision before implementing it**, not after. An ADR written
  afterwards is a justification, and it will omit the option that was rejected
  for a bad reason.
- **The trade-off section is mandatory and must be honest.** An ADR with no costs
  listed is an advertisement. If the chosen option has no downside, the
  alternatives were not real.

| Status | Meaning |
|---|---|
| **Accepted** | In force |
| **Superseded** | Replaced; the replacement is named |
| **Proposed** | Under discussion |

## Index

| ADR | Decision | Status |
|---|---|---|
| [001](#adr-001--hexagonal-architecture) | Hexagonal architecture | Accepted |
| [002](#adr-002--javascript-with-jsdoc-types-instead-of-typescript) | JavaScript with JSDoc types | Accepted |
| [003](#adr-003--modular-monolith-over-microservices) | Modular monolith | Accepted |
| [004](#adr-004--mongodb-for-conversations-with-a-documented-exit) | MongoDB for conversations | Accepted |
| [005](#adr-005--sse-over-websockets-for-streaming) | SSE over WebSockets | Accepted |
| [006](#adr-006--capabilities-as-data-not-code) | Capabilities as data | Accepted |
| [007](#adr-007--a-six-kind-provider-error-taxonomy) | Six-kind error taxonomy | Accepted |
| [008](#adr-008--per-provider-circuit-breakers-with-kind-specific-cooldowns) | Per-provider circuit breakers | Accepted |
| [009](#adr-009--a-user-pinned-model-wins-over-automatic-ranking) | User pinning wins | Accepted |
| [010](#adr-010--failover-is-never-silent) | Failover is never silent | Accepted |
| [011](#adr-011--a-three-attempt-failover-budget) | Three-attempt budget | Accepted |
| [012](#adr-012--novagpt-does-not-expose-an-openai-compatible-public-api) | No OpenAI-compatible public API | Accepted |
| [013](#adr-013--handling-adapters-that-predate-this-plan) | Pre-existing adapters | Accepted |
| [014](#adr-014--redis-is-required-for-horizontal-scaling) | Redis required to scale out | Accepted |
| [015](#adr-015--cursor-pagination-everywhere) | Cursor pagination | Accepted |
| [016](#adr-016--openapi-generated-from-runtime-validation-schemas) | Generated OpenAPI | Accepted |
| [017](#adr-017--eight-providers-in-phase-1) | Eight Phase 1 providers | Accepted |
| [018](#adr-018--compression-is-non-destructive) | Non-destructive compression | Accepted |
| [019](#adr-019--jwt-with-short-access-tokens-and-rotating-refresh-tokens) | JWT auth model | Accepted |
| [020](#adr-020--a-shared-contract-test-suite-for-every-adapter) | Shared contract suite | Accepted |

---

## ADR-001 — Hexagonal architecture

**Status:** Accepted

### Problem

NovaGPT's core value is routing logic — which model answers, and what happens
when it fails. That logic must be exhaustively testable, because its failure
modes are numerous and user-visible. In a conventional Node layout it ends up
importing Mongoose and provider SDKs, making it testable only through I/O.

### Options considered

| Option | Assessment |
|---|---|
| **Layered MVC** (`routes/` → `services/` → `models/`) | The Node default. Services import database models, so business logic depends on infrastructure. Testing routing needs a database |
| **Clean Architecture** | Same core idea with more prescribed rings and vocabulary. Ceremony without proportional benefit at this size |
| **Vertical slices** | Good for independent CRUD features. NovaGPT's features all share the routing layer, so slicing duplicates it or reinvents layering |
| **Hexagonal (ports and adapters)** | One rule: dependencies point inward through interfaces the domain owns |

### Decision

Hexagonal architecture. Four layers — `domain`, `application`, `infrastructure`,
`interfaces` — with the dependency rule enforced by lint rules in CI.

### Reasoning

It buys the property that matters most: `RoutingPolicy` and the context engine
are pure functions. Every routing decision in
[04](04-router.md#every-routing-decision-enumerated) is a unit test that runs in
microseconds with no fixtures. That is what makes exhaustive coverage of the
failure paths affordable — and the failure paths are the product.

The second benefit is provider containment. With provider adapters as driven
adapters behind a port, provider quirks physically cannot reach the router.

### Trade-offs

- More files; a trivial field addition can touch five of them.
- Mapping code between domain entities, database documents, and API responses.
- Extra indirection when tracing a call by hand.
- Easy to violate under time pressure — which is why enforcement is automated
  rather than cultural.

### Future impact

Constrains every module's placement and every import. Makes swapping
infrastructure (database, transport, provider SDK) cheap. Makes "just query the
database here" permanently unavailable as a shortcut, which is the point.

---

## ADR-002 — JavaScript with JSDoc types instead of TypeScript

**Status:** Accepted

### Problem

The domain layer has rich types — capability sets, routing decisions, error
taxonomies — where type errors are expensive. The existing codebase is
JavaScript. TypeScript would give stronger guarantees at the cost of a rewrite
and a build step.

### Options considered

| Option | Assessment |
|---|---|
| **Full TypeScript migration** | Best type safety and tooling. Costs a full rewrite and adds a compile step to every run |
| **Plain JavaScript, no types** | Simplest. No safety on the layer where mistakes are most expensive |
| **JavaScript + JSDoc, checked by `tsc --checkJs`** | Most of TypeScript's checking, no compile step, no rewrite. Weaker ergonomics for advanced types |
| **Gradual TypeScript, new files only** | Two languages in one repository indefinitely, and the boundary is a permanent source of friction |

### Decision

JavaScript with JSDoc type annotations, checked in CI with `tsc --checkJs
--noEmit`. Types live in `.d.ts` files where they are complex.

### Reasoning

Roughly 80% of TypeScript's practical benefit — editor completion, type errors in
CI, documented signatures — for near-zero migration cost and no runtime build.
The Phase 1 budget is better spent on the routing and provider layers than on a
translation that produces no user-visible change.

The escape hatch is real and cheap: JSDoc-annotated JavaScript converts to
TypeScript file by file, because the type information already exists.

### Trade-offs

- JSDoc syntax is verbose for generics and conditional types.
- Some TypeScript features (branded types, decorators, `satisfies`) are awkward
  or unavailable.
- Editor support is good but not equal.
- **This decision is contentious and will be revisited** if the domain's type
  complexity outgrows JSDoc's ergonomics — that is the trigger, and it is stated
  so the revisit happens on evidence rather than preference.

### Future impact

Keeps `node` as the only runtime requirement. Preserves a per-file migration
path. Requires that `tsc --checkJs` stays a merge gate — without it, the
annotations rot into decorative comments.

---

## ADR-003 — Modular monolith over microservices

**Status:** Accepted

### Problem

The system has separable concerns — routing, providers, conversations, context —
that could be independent services.

### Options considered

| Option | Assessment |
|---|---|
| **Microservices** | Independent scaling and deployment. Adds network hops, distributed tracing, partial-failure semantics, and operational overhead |
| **Modular monolith** | One deployable, strong internal boundaries. Scales as a unit |
| **Serverless functions** | Cheap at low volume. Cold starts are fatal for streaming, and long-lived connections fit badly |

### Decision

A modular monolith with the boundaries defined in
[02](02-architecture.md#domain-boundaries).

### Reasoning

The hard problem in NovaGPT is *already* partial failure — eight unreliable
external dependencies. Adding internal partial failure on top of that multiplies
the failure modes without addressing any of them.

There is also no scaling divergence to exploit: routing, context assembly, and
provider invocation all occur once per request, at the same rate. Microservices
pay off when components scale differently; here they would scale identically,
across a network.

Serverless is disqualified by streaming: cold starts add seconds to
time-to-first-token, and long-lived connections fight the execution model.

### Trade-offs

- The whole application scales as one unit.
- A memory leak anywhere affects everything.
- Deploys are all-or-nothing.
- Boundaries are enforced by lint rather than by network, so they can be violated
  more easily.

### Future impact

Module boundaries are drawn so that extraction remains possible: a module
communicating only through ports can become a service without changing its
callers. Revisit when a component's scaling profile genuinely diverges — for
example, if embedding generation becomes CPU-heavy and batch-shaped.

---

## ADR-004 — MongoDB for conversations, with a documented exit

**Status:** Accepted

### Problem

Conversations must be persisted. The access pattern is "load this thread with its
messages" and "append a turn". Usage records are time-series.

### Options considered

| Option | Assessment |
|---|---|
| **MongoDB** | Documents match the aggregate; one read per conversation; flexible schema; already in the stack |
| **PostgreSQL** | Relational integrity, real transactions, SQL analytics, `pgvector` for future RAG. Requires a join for the hottest read and a migration for every schema change |
| **Postgres with JSONB** | A hybrid; gets both, and also gets both sets of constraints |
| **SQLite** | Excellent for single-instance. Precludes horizontal scaling |

### Decision

MongoDB, with messages embedded in the thread document, **and the exit conditions
recorded**.

### Reasoning

The aggregate boundary and the document boundary coincide exactly. Loading a
conversation is one read; appending a turn is one atomic update. In Postgres the
same operations are a join and an insert, on the hottest path in the product.

Schema fluidity matters more than usual during Phase 1, where message metadata
and settings change every release.

Critically, the decision is **reversible**: the application depends on repository
ports, so replacing Mongo means writing one adapter
([08](08-storage.md#storage-topology)).

### Trade-offs

- No cross-collection transactions (not currently needed).
- The 16 MB document limit caps thread length; the overflow design is documented
  but unimplemented.
- Analytics on usage records is weaker than SQL.
- No `pgvector`, so RAG will need a separate store or a migration.

### Future impact

**Documented exit conditions** ([08](08-storage.md#why-not-postgres)): threads
approaching the BSON limit in real use; cross-entity queries becoming common; RAG
landing where `pgvector` would consolidate two stores into one; multi-tenancy
requiring cross-collection transactions. Any of these triggers a re-evaluation.

---

## ADR-005 — SSE over WebSockets for streaming

**Status:** Accepted

### Problem

Tokens must stream from server to browser with low latency, through proxies and
load balancers, with cancellation support.

### Options considered

| Option | Assessment |
|---|---|
| **Server-Sent Events** | Plain HTTP; inherits auth, CORS, proxies, observability; native reconnect; unidirectional |
| **WebSockets** | Bidirectional; needs a separate connection lifecycle, its own auth path, and often sticky sessions |
| **HTTP chunked with a custom protocol** | Maximum control; reinvents everything SSE already standardises |
| **Long polling** | Universally compatible; worse latency and a poor fit for token streaming |

### Decision

Server-Sent Events, one JSON object per frame.

### Reasoning

The channel is unidirectional. Choosing a bidirectional transport for a
unidirectional problem means paying for machinery — a second connection
lifecycle, a separate authentication path, sticky-session requirements — that
buys nothing.

SSE rides plain HTTP, so it inherits the bearer-token auth, the CORS policy, the
rate limiting, the logging, and the tracing that already exist. A WebSocket
upgrade bypasses all of it and each would need reimplementing.

Cancellation is also simpler: closing an HTTP connection is unambiguous, whereas
WebSocket close semantics require an application-level protocol.

### Trade-offs

- Client-to-server messages during a stream need a separate HTTP request.
- SSE is text-only; binary payloads must be encoded.
- Some proxies buffer `text/event-stream` by default and must be configured
  ([13](13-deployment.md#load-balancer-requirements--the-streaming-specific-ones)).
- Browsers cap concurrent HTTP/1.1 connections per origin — a non-issue over
  HTTP/2.

### Future impact

If a genuinely bidirectional feature arrives — live collaborative editing, or
interactive tool confirmation mid-generation — WebSockets should be added
*alongside* SSE for that feature, not as a replacement. The
`StreamEvent` protocol is transport-independent by design, so it would carry over
unchanged.

---

## ADR-006 — Capabilities as data, not code

**Status:** Accepted

### Problem

The router must know what each model can do before dispatching. That knowledge
can live in code, be probed at runtime, or be declared as data.

### Options considered

| Option | Assessment |
|---|---|
| **Code-based** (`if model.startsWith("gemini")`) | Zero infrastructure; wrong the moment a naming convention changes; unqueryable |
| **Runtime probing** | Always current, in principle; costs quota; provider `/models` endpoints do not describe capabilities |
| **Data-based catalog** | Queryable, diffable, testable; must be maintained by hand |
| **Hybrid: data primary, probe for availability** | Data for capability, probing to confirm a model is currently served |

### Decision

Hybrid, with strict precedence: catalog data is authoritative for *capability*;
live probes may only *remove* a model from the available set; adapter overrides
may only *narrow* ([03](03-provider-system.md#capability-detection)).

### Reasoning

Provider `/models` endpoints return identifiers, not capability descriptions.
Inferring "supports vision" from a model name is string matching against a
convention no provider guarantees — and the inference fails at request time, in
front of a user.

Data makes adding a model a reviewable one-line change and makes "which models
support vision?" a query rather than a debugging session.

The precedence rule encodes the asymmetry that matters: over-advertising costs a
failed request and a wasted quota unit; under-advertising costs a marginally
worse route. Probes and overrides therefore may only reduce claims.

### Trade-offs

- Manual maintenance; the catalog can go stale.
- A wrong flag causes user-visible failures the router cannot prevent.
- New models are unavailable until someone adds them.

### Future impact

Requires the `verifiedAt` field and a quarterly audit
([05](05-capability-matrix.md#maintaining-the-matrix)). Makes capability data a
first-class artifact with the same review standards as code — a wrong flag is a
bug, not a typo.

---

## ADR-007 — A six-kind provider error taxonomy

**Status:** Accepted

### Problem

Eight providers report failures differently — different status codes, different
bodies, some returning `200` with an error payload. The router must decide
consistently whether to retry, fail over, or surface.

### Options considered

| Option | Assessment |
|---|---|
| **Pass through raw errors** | No information loss; every consumer must learn eight providers' quirks |
| **Boolean retryable flag** | Simple; conflates "wait and retry" with "try elsewhere" — two different actions |
| **Six-kind taxonomy** | Each kind maps to a distinct decision |
| **A rich hierarchy of many kinds** | More precise; most distinctions map to identical behaviour |

### Decision

Six kinds: `quota`, `rate_limit`, `timeout`, `outage`, `auth`, `api_error`. Every
error crossing an adapter boundary is one of them
([03](03-provider-system.md#error-taxonomy)).

### Reasoning

The taxonomy is derived from **decisions, not causes**. Each kind answers three
questions differently: retry the same provider? fail over? open the breaker, and
for how long? A seventh kind that answers all three the same way as an existing
one adds classification work with no behavioural payoff.

The most important distinction is `api_error` versus everything else. An
`api_error` means the *request* was bad, so failing over multiplies one error
into N — the pathology this taxonomy exists to prevent.

### Trade-offs

- Information loss: the original error is reduced to a kind and a message.
- Classification can be wrong, and a misclassification causes wrong routing.
- Every adapter must map exhaustively, which is real work per provider.

### Future impact

Adding a kind is a breaking change to the router's decision table and requires
updating all adapters. The mapping is verified per adapter by the contract suite
([ADR-020](#adr-020--a-shared-contract-test-suite-for-every-adapter)), which is
what keeps the taxonomy trustworthy.

---

## ADR-008 — Per-provider circuit breakers with kind-specific cooldowns

**Status:** Accepted

### Problem

A failing provider retried by every request adds latency for every user and load
for a provider that is already struggling.

### Options considered

| Option | Assessment |
|---|---|
| **No breaker** | Simplest; every request pays the failure cost |
| **Uniform-cooldown breaker** | Standard; treats a 15-minute quota exhaustion the same as a one-second blip |
| **Kind-specific cooldowns** | Cooldown matches the expected recovery time of the actual cause |
| **Adaptive cooldown from history** | Theoretically optimal; unpredictable, hard to test, hard to reason about during an incident |

### Decision

Per-provider breakers with per-kind cooldowns and asymmetric thresholds: `quota`
and `auth` open immediately; transient kinds require three consecutive failures
([04](04-router.md#circuit-breaker)).

### Reasoning

Different failures recover on different timescales. A rate limit clears in about
a minute; a daily quota does not. One cooldown value is either too aggressive for
quota (hammering a provider that cannot serve) or too conservative for a rate
limit (a healthy provider sidelined for 15 minutes).

The threshold asymmetry follows from what a retry can achieve. A quota error is a
*fact* about provider state — a second attempt is guaranteed waste. A timeout is
a *sample* — it might be one slow request.

Adaptive cooldowns were rejected for a specific operational reason: during an
incident, an operator must be able to predict when a provider returns. A learned
value that varies per provider per hour is not predictable, and unpredictability
during an incident is expensive.

### Trade-offs

- A healthy provider can be sidelined by a transient burst.
- Cooldown values are heuristics that will need tuning with real data.
- Per-instance state is wrong in a multi-instance deployment
  ([ADR-014](#adr-014--redis-is-required-for-horizontal-scaling)).

### Future impact

Cooldown values become operational tuning parameters and must be configurable.
The active health monitor is what makes recovery faster than the nominal
cooldown, so the two mechanisms are coupled and must be reasoned about together.

---

## ADR-009 — A user-pinned model wins over automatic ranking

**Status:** Accepted

### Problem

When a user explicitly selects a model but the router's ranking prefers another,
which wins?

### Options considered

| Option | Assessment |
|---|---|
| **Router always wins** | Optimal by the router's metrics; ignores information the user has and the router does not |
| **User always wins, absolutely** | Maximum respect for intent; fails when the model is genuinely unusable |
| **User wins while usable** | Honours intent; overrides only on unavailability or incapability |
| **User wins, with a suggestion** | As above, plus a non-blocking prompt |

### Decision

The user's choice wins while the model is usable. It is overridden only when the
model is unconfigured, its breaker is open, or it cannot satisfy a hard
requirement — and the override is always reported
([ADR-010](#adr-010--failover-is-never-silent)).

### Reasoning

A user who picks a model has information the router lacks: they may be comparing
outputs, matching a colleague's result, or working around a known weakness. A
router that silently "improves" on that choice produces output the user cannot
reproduce or explain.

The trust cost is the deciding factor. A user who cannot rely on their selection
being honoured stops trusting every other automatic behaviour in the system,
including the ones that are working correctly.

### Trade-offs

- Users can pin a slow or expensive model and get a worse experience.
- A pinned free-tier model can exhaust its quota faster than ranking would.
- Requires clear UI feedback about which model actually answered.

### Future impact

Establishes the general principle: **explicit user intent beats system
inference**, everywhere. Applies to future features — retrieval settings, tool
selection, compression preferences.

---

## ADR-010 — Failover is never silent

**Status:** Accepted

### Problem

When the router switches providers mid-request, does the user learn about it?

### Options considered

| Option | Assessment |
|---|---|
| **Silent** | Cleanest interface; the user sees only an answer |
| **Always reported** | Full transparency; adds interface noise |
| **Reported only on quality-relevant switches** | Requires deciding what is quality-relevant, which is not knowable |
| **Logged but not surfaced** | Debuggable, but the user is still confused |

### Decision

Every failover is reported to the client via a `switched` event carrying the
origin model, the destination model, and the reason. This holds under all switch
policies.

### Reasoning

Silent switching produces an unexplainable experience. Model outputs differ in
tone, length, formatting, and capability. A user who notices the change with no
explanation concludes the product is unreliable — and they are reasoning
correctly from the evidence available to them.

Reported switching produces the opposite conclusion: "Gemini hit its quota, Groq
answered instead" tells the user the system detected a problem and handled it.
The same event that would damage trust builds it, purely because it was
explained.

This is also what makes `switchPolicy` meaningful — a user cannot choose `ask` or
`never` if they never learn switches are happening.

### Trade-offs

- Interface noise on every switch.
- Exposes provider unreliability that could have been hidden.
- The client must handle the `switched` event, including clearing partial
  content.

### Future impact

Constrains every future automatic behaviour to be visible: context compression,
retrieval, model downgrading under load. Anything the system does on the user's
behalf that changes the output must be surfaceable.

---

## ADR-011 — A three-attempt failover budget

**Status:** Accepted

### Problem

How many providers should be tried before giving up?

### Options considered

| Option | Assessment |
|---|---|
| **One (no failover)** | Fastest failure; abandons the multi-provider premise |
| **Two (one fallback)** | Handles single-provider failure; fails on correlated failures |
| **Three (two fallbacks)** | Handles most realistic scenarios; bounded latency |
| **All available providers** | Maximum availability; unbounded latency and quota consumption |
| **Time-budgeted rather than count-budgeted** | Elegant; a single slow attempt can consume the entire budget |

### Decision

Three attempts — one primary plus two fallbacks — with an overall 120-second
router budget as a secondary bound.

### Reasoning

Each attempt costs the full attempt latency. A user waiting through three
30-second timeouts has waited 90 seconds to receive an error — a worse outcome
than failing at 30 seconds with a clear message.

The statistical argument is stronger: if three *independent* providers fail on
one request, the cause is almost certainly not provider-specific. It is a
malformed request, an oversized context, or a network partition on our side.
More attempts will not help; they will only delay the truth and burn three more
quota units.

Count *and* time bounds together cover both failure shapes: three fast failures
are bounded by the count, one slow failure is bounded by time.

### Trade-offs

- A request can fail while a fourth healthy provider was available.
- The count is a heuristic, not derived from measurement.
- Three attempts against free tiers consume three quota units on a doomed
  request.

### Future impact

Should be revisited with production data on how often the third attempt succeeds.
If it succeeds meaningfully often, the pool ranking is the real problem — the
first choice should have been better.

---

## ADR-012 — NovaGPT does not expose an OpenAI-compatible public API

**Status:** Accepted

### Problem

Exposing `/v1/chat/completions` in OpenAI's format would make every existing
OpenAI client work with NovaGPT immediately.

### Options considered

| Option | Assessment |
|---|---|
| **OpenAI-compatible as the primary API** | Instant ecosystem compatibility; permanently couples our contract to theirs |
| **A purpose-built API only** | Full design freedom; no ecosystem compatibility |
| **Both: purpose-built primary, compatibility shim later** | Freedom now, compatibility later if there is demand |

### Decision

A purpose-built API ([09](09-api-design.md)). A compatibility shim may be added
later as a separate, clearly secondary surface.

### Reasoning

NovaGPT is a product backend, not a proxy. Its API needs concepts OpenAI's format
has no place for: threads as first-class resources, failover notifications, per-
conversation switch policies, provider status, and the context report.
Retrofitting those into `chat/completions` means abusing `metadata` fields and
inventing conventions clients cannot discover.

The deeper cost is that adopting their format means tracking their format
forever. Every OpenAI API change becomes a compatibility question for us, and our
API's evolution is governed by a company with different goals.

A shim remains possible precisely because the internal design is
provider-agnostic — it would be a translation layer over the real API, not a
constraint on it.

### Trade-offs

- Existing OpenAI-client tooling does not work out of the box.
- A client SDK must be provided or generated.
- Some adoption friction for developers expecting the familiar shape.

### Future impact

Keeps the API free to express NovaGPT's actual model. If a shim is added, it must
be a thin translation with a documented feature gap — never allowed to constrain
the primary API's design.

---

## ADR-013 — Handling adapters that predate this plan

**Status:** Accepted

### Problem

`Backend/providers/adapters/` already contains roughly eighteen adapters, ten of
which are outside the Phase 1 set of eight. They were written before this
planning phase and do not conform to the contract defined here.

### Options considered

| Option | Assessment |
|---|---|
| **Keep all eighteen as supported** | Maximum breadth immediately; eighteen untested-against-contract adapters, and the Phase 1 scope becomes fictional |
| **Delete the ten non-Phase-1 adapters** | Clean scope; discards working code and user-visible capability |
| **Keep them, bring all to contract** | No capability loss; roughly doubles Phase 2's cost and dilutes its purpose |
| **Keep them behind an explicitly unsupported flag** | No capability loss, honest scope, deferred cost |

### Decision

The Phase 1 eight are the supported, tested, documented set. Adapters outside
that set are retained but marked **unsupported**: they do not appear in the
default catalog, they are excluded from automatic routing, and they are enabled
only by explicit operator configuration. They are brought up to contract — or
removed — in Phase 5 ([14](14-roadmap.md#phase-5--provider-expansion)).

### Reasoning

Deleting working code is wasteful and would remove capability real users may be
using. Declaring all eighteen supported would make the Phase 1 scope a fiction:
"supported" means it passes the contract suite, has verified capability data, and
has live-verification sign-off, and eighteen of those is not a two-week phase.

The unsupported flag makes the distinction honest and visible rather than
implicit. An operator who enables one knows they are outside the tested set.

### Trade-offs

- Two tiers of adapter in one codebase for several phases.
- Unsupported adapters may rot until Phase 5.
- Requires a mechanism (the flag) that would not otherwise exist.

### Future impact

Phase 5 must resolve every unsupported adapter — promote it or delete it. A
permanent unsupported tier would become a place where code goes to be forgotten,
which is worse than either alternative.

---

## ADR-014 — Redis is required for horizontal scaling

**Status:** Accepted

### Problem

Circuit-breaker state, rate-limit counters, and health data are per-instance in a
naive implementation. With multiple instances each rediscovers the same failures
independently.

### Options considered

| Option | Assessment |
|---|---|
| **Per-instance state only** | No dependency; N× wasted quota and N× user-visible errors at N instances |
| **Redis-shared state** | Correct fleet behaviour; adds a dependency |
| **Gossip between instances** | No central dependency; eventual consistency, and a distributed-systems problem we do not need |
| **Database-backed state** | Reuses Mongo; adds 5–20 ms to every routing decision on the hot path |

### Decision

Redis holds shared operational state. It is **optional for a single instance and
required for more than one** ([08](08-storage.md#redis)). Redis being unavailable
degrades to per-instance behaviour rather than failing.

### Reasoning

On free tiers, quota is the scarce resource. Per-instance breakers mean a quota
exhaustion discovered by instance A is unknown to B..N, so each independently
burns quota learning the same lesson. That is not a minor inefficiency — it is
the difference between the fleet working and not.

Mongo was rejected for this specific data because it is read on *every* routing
decision, where its latency would dominate the routing budget
([12](12-testing.md#performance-testing): p99 under 5 ms).

Optionality preserves the zero-cost premise: a hobbyist single-instance
deployment needs Mongo only.

### Trade-offs

- Another service to operate in production.
- Redis latency is on the routing path (sub-millisecond, but non-zero).
- The degraded mode must be tested, or it is a guess.

### Future impact

Makes Redis a hard prerequisite for the scaling story in
[13](13-deployment.md#horizontal). Any future shared state (stream resume
buffers, distributed quota accounting) has an obvious home.

---

## ADR-015 — Cursor pagination everywhere

**Status:** Accepted

### Problem

Thread and message lists need pagination. Threads are sorted by `updatedAt`
descending, which changes constantly as conversations receive messages.

### Options considered

| Option | Assessment |
|---|---|
| **Offset/limit** | Familiar; supports jumping to page N; breaks under concurrent modification; degrades at depth |
| **Cursor-based** | Stable under modification; efficient at any depth; no arbitrary page jumps |
| **Both** | Maximum flexibility; two code paths and two sets of bugs |

### Decision

Cursor-based pagination for every collection endpoint. Cursors are opaque,
base64-encoded `{ sortValue, id }`.

### Reasoning

The sort key changes while the user paginates — that is the normal case here, not
an edge case. With offsets, a thread that moves to the top between page 1 and
page 2 shifts everything down: the client sees one item twice and misses another
entirely. The user experiences it as "a conversation disappeared", which is
alarming and unreproducible.

Offsets also degrade at depth: the database must scan and discard every skipped
document.

Page jumping is not needed — no interface in NovaGPT offers "go to page 7".

### Trade-offs

- Cannot jump to an arbitrary page.
- Total counts require a separate query.
- Cursors are opaque, so they are less debuggable by hand.

### Future impact

The opacity is deliberate: the encoding can change without breaking clients.
Applies to every future list endpoint, including usage and audit queries.

---

## ADR-016 — OpenAPI generated from runtime validation schemas

**Status:** Accepted

### Problem

The API needs documentation. Documentation that drifts from behaviour is worse
than none, because it is trusted.

### Options considered

| Option | Assessment |
|---|---|
| **Hand-written OpenAPI** | Full control; a second source of truth that drifts within weeks |
| **Generated from JSDoc comments** | Lives next to the code; comments are not executable, so they drift identically |
| **Generated from runtime validation schemas** | Cannot drift — the spec's source is what enforces the contract |
| **No spec** | Nothing to maintain; no client generation, no contract tests, no discoverability |

### Decision

Zod schemas are the single source of truth. They validate at runtime, infer
static types for `tsc --checkJs`, and generate the OpenAPI 3.1 document at build
time. CI fails if the committed spec differs from the generated one.

### Reasoning

Drift becomes structurally impossible. If the spec is wrong, validation is wrong,
and tests fail. That is a fundamentally different guarantee from "someone
remembered to update the spec" — the failure mode is a broken build rather than
silently misleading documentation.

One declaration produces three artifacts: the validator, the type, and the
documentation. Three things that must agree, derived from one thing, cannot
disagree.

### Trade-offs

- Couples the API surface to Zod.
- Generated specs are sometimes less elegant than hand-written ones.
- Complex response shapes need schema gymnastics.

### Future impact

Enables generated client SDKs and automated breaking-change detection in CI. Any
future endpoint MUST define Zod schemas — a hand-written route without them
cannot be documented or contract-tested.

---

## ADR-017 — Eight providers in Phase 1

**Status:** Accepted

### Problem

How many providers should the first release support? Each adds capability and
redundancy but also maintenance surface and testing cost.

### Options considered

| Option | Assessment |
|---|---|
| **One** | Simplest; no failover, so the architecture is unproven and the premise untested |
| **Three** | Proves failover; thin capability coverage; a correlated outage is plausible |
| **Eight** | Covers every capability twice, spans jurisdictions, mostly one dialect |
| **Everything available (18+)** | Maximum breadth; testing and verification cost dominates the phase |

### Decision

Eight: Gemini, Groq, DeepSeek, Qwen, Mistral, OpenRouter, GLM/Zhipu, NVIDIA NIM
([01](01-system-overview.md#supported-providers-phase-1)).

### Reasoning

Eight is the smallest number satisfying all four constraints at once: a zero-cost
floor (six free tiers), two providers per capability axis so failover never drops
a capability, failure independence across four jurisdictions and six
infrastructure operators, and a single wire dialect for seven of the eight so
adapter cost stays near-zero.

Three would satisfy the first constraint but not the second — a single vision
provider means a vision request has no failover destination.

### Trade-offs

- Eight adapters to maintain and verify.
- Eight sets of terms to track.
- Context above 256K is Gemini-only — a known, documented single point of failure
  ([05](05-capability-matrix.md#coverage-analysis--why-this-set-is-sufficient)).
- Excludes OpenAI and Anthropic, which many users will expect.

### Future impact

Phase 5 closes the large-context gap as its highest priority. The
two-providers-per-capability rule becomes the standing criterion for whether a
new provider is worth adding.

---

## ADR-018 — Compression is non-destructive

**Status:** Accepted

### Problem

Long conversations exceed context windows. Summarising old turns recovers space
but loses detail.

### Options considered

| Option | Assessment |
|---|---|
| **Replace messages with the summary** | Maximum space saving; irreversible data loss; the user's scrollback changes silently |
| **Store summaries alongside originals** | No data loss; strategies can be re-applied; costs storage |
| **Do not compress; only drop** | Simplest; loses substance entirely rather than detail |

### Decision

Summaries are stored as separate documents alongside the original messages, which
are never modified or deleted. The engine chooses at assembly time which
representation to use.

### Reasoning

Compression is lossy, and a lossy transformation applied irreversibly to user
data is a data-loss bug waiting for its trigger. If the summariser produces a bad
summary — or hallucinates — destroying the originals makes it unrecoverable.

Non-destructive storage also means a better compression strategy can be applied
retroactively, and the user's visible history never changes underneath them.

Storage is the cheapest resource in this system. Trading it for reversibility is
an obviously good trade.

### Trade-offs

- Threads store both originals and summaries, accelerating growth toward the
  BSON limit.
- Assembly must decide which representation to use, adding logic.
- Summaries can become stale relative to edited history.

### Future impact

Makes summarisation strategy a runtime decision rather than a migration.
Interacts with the document-size limit ([ADR-004](#adr-004--mongodb-for-conversations-with-a-documented-exit)),
which is what makes the message-archive overflow design necessary rather than
optional.

---

## ADR-019 — JWT with short access tokens and rotating refresh tokens

**Status:** Accepted

### Problem

Authentication must be stateless enough to scale, revocable enough to be safe,
and resistant to XSS token theft.

### Options considered

| Option | Assessment |
|---|---|
| **Server-side sessions in Redis** | Instantly revocable; makes Redis a hard availability dependency for the whole product |
| **Long-lived JWTs** | Fully stateless; unrevocable, so a stolen token is valid for its full lifetime |
| **Short access + rotating refresh** | Bounded exposure, revocable at the refresh point, degrades gracefully |
| **Opaque tokens with a database lookup** | Fully revocable; a database round trip on every request |

### Decision

RS256 JWTs. 15-minute access tokens in client memory; 30-day rotating refresh
tokens in httpOnly, Secure, SameSite=Strict cookies; a Redis denylist for
immediate revocation ([10](10-security.md#authentication)).

### Reasoning

A stolen access token is useful for at most 15 minutes and cannot be read by
JavaScript-side code paths that matter, because the *refresh* token — the durable
credential — is in an httpOnly cookie and unreachable from JavaScript. That is
what makes an XSS bug damaging but not catastrophic.

Rotation makes theft *detectable*: reuse of a rotated refresh token proves
compromise, at which point the whole token family is revoked. Without rotation, a
stolen 30-day token is 30 days of undetectable access.

Keeping the access token out of cookies removes CSRF from the API surface
entirely, since requests are never authenticated by ambient credentials.

Redis sessions were rejected because they would make Redis a hard dependency for
the entire product, contradicting "degrade, don't collapse". With this design,
losing Redis delays revocation by at most one access-token lifetime.

### Trade-offs

- A revoked access token stays valid until it expires (up to 15 minutes).
- Rotation adds client complexity around concurrent refreshes.
- RS256 key management and rotation are additional operational work.

### Future impact

Sets the 15-minute window as the maximum revocation delay for the whole system.
The `kid` header makes signing-key rotation possible without invalidating every
session.

---

## ADR-020 — A shared contract test suite for every adapter

**Status:** Accepted

### Problem

The router assumes every adapter behaves identically at the boundary: same error
kinds, same stream normalisation, same cancellation semantics. Nothing enforces
that assumption.

### Options considered

| Option | Assessment |
|---|---|
| **Per-adapter tests, written independently** | Flexible; drifts, and the guarantee one author skipped is the one the router relies on |
| **A shared suite run against every adapter** | Uniform guarantees; constrains adapter design |
| **Integration tests only** | Tests real behaviour; slow, quota-consuming, and flaky |
| **Trust the base class** | Cheap; provides nothing for bespoke adapters like Gemini |

### Decision

One shared suite of 20 cases, run against every adapter with mocked HTTP
([12](12-testing.md#the-shared-provider-contract-suite)). Passing it is a
mandatory onboarding gate.

### Reasoning

The router's correctness is a *fleet* property, not a per-adapter property. It
depends on every adapter mapping `429`-with-quota-body to `quota`, on every
adapter cancelling within 100 ms, on every adapter buffering split SSE frames. A
single adapter that gets one of those wrong breaks routing in a way that looks
like a router bug.

Per-adapter tests cannot provide this, because there is no mechanism forcing
adapter number eight to test the same things as adapter number one.

It also makes onboarding objective. "Does this adapter work?" becomes a suite
result rather than a judgement call in review.

### Trade-offs

- Constrains adapter implementations to a common shape.
- A shared-suite change touches all eight adapters at once.
- Mocked HTTP tests what we *believe* providers do, which is why live
  verification remains a separate mandatory step.

### Future impact

Every new capability added to `ProviderPort` needs corresponding contract cases.
The suite is the mechanism that keeps provider onboarding cheap *and* safe — and
it is what makes the claim "adding a provider takes an hour" verifiable rather
than aspirational.

---

## ADR-021 — The JWT codec and the cookie codec are written here, not imported

**Status:** Accepted

### Problem

Tokens and cookies need encoding and decoding. Both have well-maintained
libraries. Every dependency is also code we ship and cannot audit, and the
supply chain (T14) has the worst effort-to-impact ratio available to an
attacker.

### Options considered

| Option | Assessment |
|---|---|
| **`jsonwebtoken` + `cookie-parser`** | Familiar; two dependencies and their transitive trees on the authentication path |
| **`jose`** | Modern, well-audited, broad; the breadth is the cost — it supports algorithms and flows this system deliberately does not |
| **Write both** | ~90 lines total, fully auditable; ours to get wrong |

### Decision

`JwtSigner` and `cookies.js` are written against `node:crypto` and the standard
library.

### Reasoning

JWT is a small, frozen format, and the parts libraries get wrong are precisely
the parts that matter: taking `alg` from the token header — which permits the
`alg: none` and HS-with-the-RSA-public-key forgeries — and lenient claim
checking. Here the algorithm is fixed by the module and the header's `alg` is
*verified against* it, never *used to select* it. Both attacks are asserted in
`test/unit/jwt.test.js`.

The cookie codec parses only what this application sets, which additionally
means a malformed third-party cookie cannot make request handling throw.

### Trade-offs

- We own the correctness. Mitigated by keeping the surface tiny and the tests
  adversarial rather than illustrative.
- No JWK/JWKS endpoint, no encrypted tokens, no algorithm agility. None are
  required; if a JWKS endpoint is ever needed, `jose` becomes the right answer
  and this decision should be revisited rather than extended.

---

## ADR-022 — `null` is an owner, not a wildcard

**Status:** Accepted · **Supersedes the pre-auth behaviour of the repositories**

### Problem

Before accounts existed, both thread repositories treated a `null` owner as "no
scoping requested" and returned every thread. That was harmless with no
accounts. With accounts, a single call site that forgot to pass an owner — or a
principal that was `undefined` rather than a `Principal` — became a full
cross-user disclosure (T5).

### Decision

Owner scoping is strict equality including `null`. Anonymous callers scope to
`null` and see threads with no owner, which is a scope like any other.
`Principal.anonymous()` exists so that `req.principal` is *always* an object and
there is no call site where a missing check silently becomes "no scope".

Two structural consequences follow, and both are enforced rather than reviewed:

- `save()` includes the owner in its filter. A caller who supplies another
  user's thread id no longer upserts over that conversation; the unique index on
  `id` refuses the insert.
- `ChatOrchestrator` answers **404** when a supplied thread id exists under a
  different owner, rather than creating a thread that would take it over on the
  next save. 404 rather than 403, because 403 confirms the id exists.

### Reasoning

A permissive default is a defence that works until someone forgets, and this one
failed *open*. Making the safe behaviour the default one costs a strict equality
and removes the entire class.

### Trade-offs

Threads created before authentication landed have `userId: null` and are now
visible only to anonymous callers. With `AUTH_REQUIRED=true` that means they are
not visible at all. Accepted: pre-auth conversations belong to nobody, and
assigning them to the first account that asks would be worse.

---

## ADR-023 — The first registered account is the operator

**Status:** Accepted

### Problem

An admin has to exist before anyone can be promoted to one. Every mechanism for
creating the first one has a failure mode.

### Options considered

| Option | Assessment |
|---|---|
| **A seeded default account** | Simple; a well-known credential shipped to every deployment, and the one people forget to change |
| **An environment variable naming the admin email** | Explicit; a variable that only matters once, and silently does nothing if set after first boot |
| **Manual database edit** | No code; undocumented, unrepeatable, and requires database access to run the product |
| **First account wins** | One rule, no credential, no extra variable; a race if registration is open and unattended |

### Decision

The account created when the user collection is empty is an `admin`. Everything
after it is a `user`.

### Reasoning

It is the only option that creates no credential and no configuration that can
be got wrong later. The operator installs the product and signs up; that is the
whole procedure.

### Trade-offs

A deployment left open and unattended between first boot and first registration
hands admin to whoever arrives first. `AUTH_ALLOW_REGISTRATION=false` after
setup is the control, and the deployment runbook says so.

---

## ADR-024 — Tracing is collected in process, not through an OpenTelemetry SDK

**Status:** Accepted

### Problem

The observability design calls for OpenTelemetry with **tail-based sampling**.
Those two requirements pull in different directions: the OTel Node SDK does not
make tail-based sampling decisions in process. It cannot — the decision needs
the whole trace, and the SDK exports spans as they finish. Tail sampling in the
OTel world is a *collector* feature, which means the design as written requires
deploying and operating an OpenTelemetry Collector.

### Options considered

| Option | Assessment |
|---|---|
| **Full OTel SDK + Collector with tail sampling** | The canonical answer; correct at scale. Six or more dependencies plus a collector deployment, for a system whose current deployment target is "a single VM with Docker Compose" |
| **OTel SDK, head-based sampling** | Fewer moving parts; throws away exactly the traces that turn out to matter, which is the specific failure the design rejects |
| **OTel SDK for spans, our own buffering and sampling** | Keeps the wire format; the SDK's value *is* its exporters and its context management, both of which this would bypass |
| **Collect and sample in process** | ~180 lines, no dependencies, tail sampling actually works; the wire format is ours until an exporter is written |

### Decision

`Tracer` and `SamplingPolicy` are written against `node:async_hooks` and
`node:crypto`. Sampled traces are exported through a one-method interface, whose
current implementation writes them as `trace.sampled` log events.

### Reasoning

The part with real value here is the sampling policy — keep every error, every
failover and every slow request, sample the rest at 5% — and that is pure
arithmetic over a finished trace. It is ~70 lines and it is fully unit-tested,
including the cases that matter (a successful failover, a 5xx that never threw,
a 4xx that must *not* be treated as an error).

What the SDK would contribute on top is span plumbing and exporters. The
plumbing is small, because async local storage does the hard part. The exporters
are the thing worth having — and the day one is needed, `LogSpanExporter` is
replaced by an OTLP exporter behind the same method, without touching a single
instrumented call site.

Meanwhile W3C `traceparent` propagation is implemented, so NovaGPT already joins
an upstream trace and passes one downstream. The interoperability that actually
matters does not depend on the SDK.

### Trade-offs

- No Jaeger or Tempo view until an exporter is written. Traces are read from the
  log pipeline, where they sit beside the log lines from the same request — which
  during an incident is arguably better, and at volume is worse.
- No automatic instrumentation of `http`, `mongodb` or `ioredis`. Spans exist
  where they were deliberately placed. Fewer spans, all of them meaningful.
- The buffer holds a trace until its root ends. Bounded by `TRACE_MAX_SPANS`,
  and the bound is asserted.

### Revisit when

Trace volume outgrows the log pipeline, or someone wants a flame graph. Both are
signals to write an OTLP exporter — not to rewrite the instrumentation.

---

## ADR-025 — An unpriced model costs `null`, not zero

**Status:** Accepted

### Problem

`CostTable.costFor` returns a number for a priced model. A model with no entry
has to return *something*, and the obvious candidate is `0` — every free-tier
model already costs zero, so the value looks harmless.

### Decision

Unpriced returns `null`. Free returns `0`. They are stored differently,
aggregated differently, and only one of them is reported as spend.

### Reasoning

They mean opposite things. `0` is a measured fact: this model is free, and we
know it. `null` is an absence: nobody has told the system what this costs.

Collapsing them makes the failure silent and self-reinforcing. A new provider
ships, someone adds the adapter and forgets the price table, and the cost
dashboard reports the fleet getting *cheaper* as traffic moves onto a model
whose spend is invisible. The number looks plausible, so nobody investigates —
and the panel that exists to catch cost anomalies is now the thing hiding one.

With `null`, the tokens are still counted (so consumption is right), the cost
metric is not incremented (so spend is not understated as zero), and
`CostTable.unpriced()` names the gap for the quarterly audit.

### Trade-offs

- Every aggregation must decide what to do with `null`. Both repository
  implementations coalesce to zero *when summing* while keeping the record's
  value intact — asserted in both, because a double that summed differently
  would let a cost test pass and be wrong in production.
- A dashboard summing raw cost slightly understates a fleet with unpriced
  models. That is the honest direction to be wrong in, and the audit closes it.

---

## ADR-026 — Ollama joins the fleet

**Status:** Accepted · *Required by step 2 of the onboarding process*

### Problem

Every provider needs a recorded justification for existing, and the bar is
explicit: *a provider that adds only redundancy we already have is not worth the
maintenance surface* ([03](03-provider-system.md#provider-onboarding-process)).
Ollama adds no capability the fleet lacks — its models are weaker than every
hosted one on the list.

### Decision

Add it anyway, and ship it dark.

### Reasoning

It adds an axis nothing else in the fleet has: **failure independence from the
network itself.** Every other provider shares one dependency — the host's
internet connection — so a fleet of eight is still a fleet of one against that
failure. Ollama is the only candidate that can answer during a total upstream
outage, which is precisely the scenario the multi-provider design exists for and
the one it could not previously survive.

Two further properties, either of which would be marginal alone:

- **Prompts never leave the host.** For a deployment that cannot send
  conversation content to a third party, this is the difference between using
  the product and not using it.
- **Zero marginal quota.** It cannot exhaust a free tier, which makes it the
  natural last resort once every hosted provider has.

### Trade-offs

- **Quality and speed vary by two orders of magnitude with the host's
  hardware**, so the declared scores are deliberately pessimistic and the
  provider ships dark. Ranking should learn what a given deployment's Ollama is
  actually worth from telemetry, not from a number guessed here.
- The declared models are a *floor, not a promise*: which models an Ollama has
  pulled is a property of that machine. A deployment running something else
  should override the catalog entries rather than let the router assume a model
  that is not installed.
- It is the first provider enabled by an **endpoint** rather than a credential,
  which required a change to the factory (below).

---

## ADR-027 — A provider is enabled by its declared variable, credential or not

**Status:** Accepted · *Amends the Phase 2 factory rule*

### Problem

The rule was "a provider is enabled by having a credential", implemented as
`configured = requiresCredentials ? Boolean(credential) : true`. Ollama has no
credential to have, so `requiresCredentials: false` made it **unconditionally
configured** — registered on every deployment, whether or not an Ollama existed.

The failure mode is quiet and bad: a provider in the catalog with nothing
listening behind it. Routing considers it, sends it a request, and the request
fails. It is a fleet member that exists only to consume an attempt.

### Decision

A provider is configured when **one of its declared variables is set**,
regardless of whether that variable is a credential. `requiresCredentials: false`
with no declared variables still means "always available", which is what the
mock adapter needs.

A provider needing no credential receives its variable as `settings.baseURL`
rather than as a `Secret`.

### Reasoning

The original rule was right about the *principle* — enablement is a deliberate
operator act, not a default — and wrong about the *mechanism*, which assumed
that act was always "supply a key". Setting `OLLAMA_BASE_URL` is the same
deliberate act; the value simply is not secret.

Not wrapping it matters more than it looks. Wrapping a non-secret in `Secret`
would mean `.expose()` calls that are not exposing anything, and the value of
that wrapper is entirely in what a reader infers when they see it. Diluting it
with non-secrets is how it stops being a signal.

### Trade-offs

An adapter whose endpoint is genuinely optional now needs a default in the
adapter rather than relying on the factory. That is one line, and it puts the
default next to the code that knows what a sensible one is.
