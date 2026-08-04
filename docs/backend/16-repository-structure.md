# 16 — Repository Structure

## Principles

**Directory structure encodes architecture.** The layout mirrors the layers in
[02](02-architecture.md), so a misplaced file is visible in a file tree rather
than only in an import graph. When structure and architecture disagree, the
structure wins in practice — people put files where similar files already are.

**Every directory earns its existence.** A directory exists because it has a
distinct responsibility, not because a file needed somewhere to live. Directories
with one file and no plan for a second are noise.

**Structure follows the dependency rule.** Reading top to bottom in the tree below
is reading inward: `interfaces` → `application` → `domain`, with
`infrastructure` implementing what `domain` declares.

## The tree

```
Backend/
├── src/
│   ├── domain/
│   │   ├── conversation/
│   │   ├── routing/
│   │   ├── capability/
│   │   ├── context/
│   │   ├── streaming/
│   │   ├── context/
│   │   ├── lifecycle/
│   │   ├── provider/
│   │   ├── identity/
│   │   ├── security/
│   │   ├── observability/
│   │   ├── usage/
│   │   ├── errors/
│   │   └── ports/
│   ├── application/
│   │   ├── chat/
│   │   ├── threads/
│   │   ├── catalog/
│   │   ├── health/
│   │   ├── providers/
│   │   ├── routing/
│   │   ├── streaming/
│   │   ├── identity/
│   │   ├── security/
│   │   ├── usage/
│   │   ├── admin/
│   │   └── shared/
│   ├── infrastructure/
│   │   ├── providers/
│   │   │   ├── adapters/
│   │   │   ├── shared/
│   │   │   ├── registry/
│   │   │   ├── health/
│   │   │   └── catalog/
│   │   ├── persistence/
│   │   │   ├── mongo/
│   │   │   └── memory/
│   │   ├── cache/
│   │   │   ├── redis/
│   │   │   └── memory/
│   │   ├── security/
│   │   ├── system/
│   │   ├── telemetry/
│   │   └── config/
│   ├── interfaces/
│   │   └── http/
│   │       ├── controllers/
│   │       ├── middleware/
│   │       ├── schemas/
│   │       └── serializers/
│   ├── container.js
│   └── main.js
├── test/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   ├── e2e/
│   ├── load/
│   ├── fixtures/
│   └── helpers/
├── scripts/
├── docs/
├── .env.example
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## `src/domain/` — the pure core

**Purpose:** business logic with no I/O, no framework, no external dependencies.

**Why it exists:** this is the only layer whose logic is genuinely hard, and
isolating it is what makes exhaustive testing affordable
([ADR-001](15-decisions.md#adr-001--hexagonal-architecture)).

**Hard rules:** no imports from any other `src/` layer; no npm package that
performs I/O; no `process.env`; no `Date.now()`; no `Math.random()`.

| Directory | Contains | Why it is separate |
|---|---|---|
| `conversation/` | `Thread`, `Message`, `ConversationSettings`, and their invariants | Conversation rules change with product decisions; routing rules change with operational learning. Different reasons to change |
| `routing/` | `RoutingPolicy`, ranking, `RoutingDecision`, `CircuitBreaker` | The system's most important and most-tested logic. Isolated so it is trivially testable and obvious where to find |
| `capability/` | `CapabilityMatrix`, `ModelDescriptor`, `RequirementSet`, matching | Separate from `routing/` because capabilities change when providers ship models (frequent, data, low risk) while routing changes when strategy changes (rare, logic, high risk). Fusing them means every new model touches the ranking algorithm's file |
| `context/` | `ContextEngine`, `TokenEstimator`, `TokenBudget`, `TrimmingPipeline`, `Summarizer`, `MemoryInjection`, `ContextReport` | An independent pipeline with its own invariants; used by chat but conceptually separate. Pure and deterministic, so "what happens to a 200-message thread at a 128K budget?" is a unit test |
| `streaming/` | `StreamEvent` types, session state, terminal-event rules | The protocol is domain vocabulary. Its *transport* is not, and lives in `interfaces/` |
| `provider/` | `ProviderState` (the phase machine, merged with the circuit breaker), `ProviderDescriptor` | Kept out of `capability/` because they change for different reasons: a provider's *health* changes second to second, its *capabilities* change when a provider ships a model. See [03](03-provider-system.md#one-state-object-not-two) for why the breaker and the lifecycle are one object |
| `lifecycle/` | `ServiceState` — the process phase machine (starting → ready → draining → stopped) | Read by the readiness check (application) and driven by the shutdown handler (infrastructure). Since those two may import the domain but not each other, this is the only placement that keeps the dependency rule intact. The one-way transitions are a real rule: a draining process must never advertise itself ready again |
| `identity/` | `User`, `Session`, `Principal`, `Role`/`Permission`, `LockoutPolicy`, credential rules | Accounts are a domain concern, not an HTTP one. `Principal` in particular: it exists so `req.principal` is always an object, which is what removes the call site where a missing null check silently becomes "no owner scope" ([10](10-security.md#what-scoped-by-owner-actually-means)) |
| `security/` | `RateLimitRule`, `RateLimitDecision` | Deciding whether a count is over the line is arithmetic; counting is I/O. Splitting them puts every threshold, boundary and fail-open/fail-closed choice in a unit test with no Redis in sight |
| `observability/` | `Span`, `SamplingPolicy` | Deciding which traces are worth keeping is arithmetic over a finished trace, with no clock and no I/O. In the domain, it is a unit test; in a tracing backend, it is something you observe later and cannot reproduce |
| `usage/` | `UsageRecord` | One provider attempt as an accounting fact. In the domain because the rules — a cancelled attempt is not a failed one, an unpriced model is not a free one — are decisions, not storage details ([ADR-025](15-decisions.md#adr-025--an-unpriced-model-costs-null-not-zero)) |
| `errors/` | `ProviderError`, `FailureKind`, `UnsupportedCapabilityError`, failover rules | Every layer references these. A dedicated home prevents circular imports between contexts that all need the taxonomy |
| `ports/` | Interfaces the domain declares: `ProviderPort`, `ThreadRepositoryPort`, `CachePort`, `ClockPort`, `LoggerPort`, `RetrievalPort`, `UserRepositoryPort`, `SessionRepositoryPort`, `PasswordHasherPort`, `TokenSignerPort`, `AuditLogPort` | **The most important directory in the repository.** These interfaces are what invert the dependency: infrastructure implements what the domain requires, rather than the domain adapting to what infrastructure offers ([02](02-architecture.md#why-ports-are-owned-by-the-domain)) |

---

## `src/application/` — use cases

**Purpose:** orchestrate domain logic and ports to accomplish one user-visible
operation.

**Why it exists:** some logic is sequencing, not policy — "load the thread,
assemble context, route, invoke, persist, emit telemetry, in this order, with
these failure semantics". It is not a business rule and it is not HTTP. Without
this layer it lands in controllers (duplicated across REST and SSE) or in the
domain (which then needs I/O).

**Rules:** may import `domain/`; MUST NOT import `infrastructure/` or
`interfaces/`. Receives plain commands, returns plain results.

| Directory | Contains | Note |
|---|---|---|
| `chat/` | `ChatOrchestrator`, `StreamRegistry` | The core product path. `RoutingExecutor` lives here, not in `domain/`, because it performs I/O — the *policy* is pure, the *execution* is not |
| `threads/` | Thread CRUD, settings, duplicate, share | |
| `catalog/` | Model catalog assembly with live status | Joins static capability data with live registry state |
| `streaming/` | `StreamingExecutor` — the streaming twin of `RoutingExecutor` | Separate because streaming changes the failure model: a failure can arrive after the client has rendered 400 tokens, so buffer resets, switch ordering, and the ban on in-place retry have no analogue in the request/response path |
| `routing/` | `RoutingService` (request → decision) and `RoutingExecutor` (walk the chain, retry, fail over) | Both are orchestration over ports. Ranking stays in `domain/routing/` and I/O mechanics in `infrastructure/routing/`, so neither leaks into the other |
| `providers/` | `ProviderManager` — owns the discover → load → construct → register → watch sequence | The sequence is orchestration with defined ordering and failure semantics, which is what a use case is. None of the five infrastructure pieces it drives knows the sequence, so each stays independently testable |
| `health/` | `CheckLiveness`, `CheckReadiness`, `GetVersion` | Health is orchestration, not policy: readiness aggregates independent probes by criticality and applies the draining rule. Keeping it here — rather than in the controller — is what makes "Redis down must not empty the load balancer" a unit test instead of an integration test |
| `admin/` | Health probes, provider enable/disable, metrics access | Separated so admin operations are obvious in review and easy to gate |
| `shared/` | Cross-cutting use-case concerns (idempotency, command validation) | Only for genuinely shared logic — a dumping ground here becomes the layer's `utils/` |

**One use case per file, named for the operation.** A `ChatService` accumulates
every chat-adjacent function until it has eleven reasons to change; a use case
has one, and its test file length is a direct signal of that operation's
complexity.

---

## `src/infrastructure/` — port implementations

**Purpose:** everything that talks to the outside world.

**Rules:** may import `domain/` (to implement its ports and use its types); MUST
NOT import `application/` or `interfaces/`.

### `providers/`

| Directory | Contains | Why |
|---|---|---|
| `adapters/` | One folder per provider: `gemini/`, `groq/`, `deepseek/`, `qwen/`, `mistral/`, `openrouter/`, `zhipu/`, `nvidia/` | One folder per provider is what makes "add a provider = add a folder" literally true. It also makes deletion trivial, which is the real test of modularity |
| `shared/` | `OpenAIDialectProvider`, the resilient HTTP client, SSE parsing, retry and backoff | Shared by seven adapters. Changes here affect all of them — which is why the contract suite runs against every adapter ([ADR-020](15-decisions.md#adr-020--a-shared-contract-test-suite-for-every-adapter)) |
| `registry/` | `ProviderRegistry`, `ProviderFactory`, health monitor, status projection | Registry is infrastructure, not domain: it holds live operational state and constructs adapters. The *policy* that consumes its snapshot is in `domain/routing/` |
| `catalog/` | `ModelRegistry` plus model data | Data, not logic. A model is added by a data change and registered dynamically by its adapter, so there is no central list to edit |
| `health/` | `ProviderHealthManager` | Separate from `registry/` because passive tracking and active probing have different failure rules: a real call may open a breaker, a probe may only ever close one |

**Why the catalog is in `infrastructure/` and not `domain/`.** The catalog is a
*data source* — today a file, tomorrow possibly a database table or a remote
config service. The domain owns the `ModelDescriptor` *type* and the matrix
*logic*; where the data comes from is an infrastructure concern.

### `persistence/mongo/`

| Contains | Note |
|---|---|
| `schemas/` | Mongoose schemas — the database's shape |
| `repositories/` | Implementations of the repository ports |
| `mappers/` | Document ↔ domain entity translation |
| `migrations/` | Versioned, backward-compatible schema changes |

**Why mappers are a separate directory rather than methods on the schema.** They
enforce that a Mongoose document never escapes the persistence layer. A repository
returning a raw document leaks the database schema into the domain and makes any
schema change a domain change ([09](09-api-design.md#principles)).

### `cache/`

`redis/` holds the shared implementation; `memory/` holds the in-process one.

`memory/` is **not a stub**. It is the documented degraded mode when Redis is
unreachable, and the correct implementation for a single-instance deployment
([08](08-storage.md#redis-must-be-optional-and-what-that-costs)). Making it a
real implementation of the same port — rather than `if (redis)` branches in
callers — is what makes the degraded path testable
([13](13-deployment.md#degradation-matrix)). `createCache.js` picks between them
once, at composition time, so no caller ever learns which one it got.

### `routing/`

`ProviderInvoker` runs one attempt with a deadline and an abort signal, measures
it, and normalises whatever was thrown into the failure taxonomy.
`RegistrySnapshotSource` freezes live registry state into the immutable
`HealthSnapshot` the pure policy consumes — the seam between mutable
infrastructure and pure domain.

### `system/`

The clock and the graceful-shutdown sequencer.

The clock exists so that `Date.now()` appears exactly once in the codebase, which
is what lets a 15-minute cooldown be tested in a microsecond. The shutdown
sequencer owns the ordering — unready, wait, close listener, close resources,
exit — described in [13](13-deployment.md#graceful-shutdown).

### `telemetry/`

Structured logger with redaction, metrics registry with a label allowlist,
tracing setup, and the usage recorder. Grouped because they share the trace
context and must be initialised together, before anything else can emit.

### `config/`

Environment schema, validation, and the typed config object. **The only place
besides `main.js` allowed to read `process.env`** — enforced by lint
([02](02-architecture.md#enforcement)).

---

## `src/interfaces/http/` — driving adapters

**Purpose:** translate HTTP into use-case calls and results back into HTTP.

| Directory | Contains | Why separate |
|---|---|---|
| `controllers/` | Thin handlers; one per resource | Parse, delegate, serialise. A controller containing an `if` that decides *what the system does* has business logic in the wrong layer |
| `middleware/` | Auth, rate limiting, validation, trace-id assignment, error handling, CORS | Cross-cutting concerns that apply to many routes. Ordering matters and is documented in the router setup |
| `schemas/` | Zod request and response schemas | The single source of truth for validation, types, and OpenAPI ([ADR-016](15-decisions.md#adr-016--openapi-generated-from-runtime-validation-schemas)) |
| `serializers/` | Domain entity → API response | Field-by-field construction. A serialiser that spreads an internal object is a review blocker — that is how keys and internal state leak ([10](10-security.md#structural-defences-against-leakage-t1)) |

**The SSE controller lives here, alongside REST controllers**, because SSE is a
transport concern. The `StreamEvent` protocol it serialises is in
`domain/streaming/`.

---

## Composition root

| File | Purpose |
|---|---|
| `container.js` | Constructs concrete adapters and injects them. The **only** place that knows about all layers at once |
| `main.js` | Bootstrap: load config, build the container, start the server, register shutdown handlers |

**Why exactly two files.** A single composition root is what makes the dependency
rule *enforceable* rather than aspirational: one lint rule plus one wiring
location means an accidental violation fails CI instead of quietly becoming the
new normal.

**Why a hand-written container and not a DI framework.** At this size the wiring
is roughly 50 lines of explicit construction — readable, debuggable, and
traceable by reading. A DI container adds decorators, reflection, and startup
magic to solve a problem we do not have. Revisit if the wiring exceeds a few
hundred lines.

---

## `test/`

Mirrors `src/` in structure so a test's location is predictable from the code it
covers.

| Directory | Contains | Runs |
|---|---|---|
| `unit/` | Domain-layer tests | Every save |
| `contract/` | The shared provider suite, run against all adapters | Every commit |
| `integration/` | Use cases with real Mongo and mocked provider HTTP | Every push |
| `e2e/` | Full HTTP through to persistence | Every PR |
| `load/` | `autocannon` scenarios | Manually and pre-release |
| `fixtures/` | Captured provider responses, credentials scrubbed | — |
| `helpers/` | Fake providers, fake clock, builders, mock setup | — |

**Why fixtures are top-level rather than beside each adapter's tests.** They are
shared across the contract, integration, and e2e suites. Duplicating them would
guarantee they diverge, and a diverged fixture makes one suite pass while another
fails on the same behaviour.

---

## Supporting directories

| Directory | Contains | Note |
|---|---|---|
| `scripts/` | Fixture capture, catalog validation, load-test drivers, migration runners | Operational tooling, deliberately outside `src/` — it is not part of the application |
| `docs/` | This handbook | Committed alongside the code so documentation changes are reviewed with the changes they describe |

---

## Naming conventions

| Kind | Convention | Example |
|---|---|---|
| Directories | kebab-case | `openai-compatible/` |
| Domain entities and classes | PascalCase | `RoutingPolicy.js` |
| Use cases | PascalCase, verb-first | `StreamMessage.js` |
| Ports | PascalCase, `Port` suffix | `ProviderPort.js` |
| Adapters | PascalCase, provider-named | `GroqAdapter.js` |
| Tests | Mirror the source, `.test.js` | `RoutingPolicy.test.js` |
| Data files | kebab-case | `model-catalog.js` |

**Every module has a default or named export matching its filename.** A file
named `RoutingPolicy.js` exporting something else makes navigation by filename
unreliable, which is how a codebase becomes searchable only by grep.

---

## Deliberately absent

| Not present | Why |
|---|---|
| `utils/` | A directory with no responsibility. Everything in a typical `utils/` belongs to a specific concern — put it there. `utils/` is where code goes when nobody decided where it belongs, and it grows until nobody can safely change anything in it |
| `helpers/` in `src/` | Same reasoning. `test/helpers/` is fine — its scope is bounded |
| `services/` | Ambiguous by construction. Use cases are in `application/`, adapters in `infrastructure/`, policy in `domain/`. "Service" names none of those |
| `models/` | Ambiguous between domain entities, database schemas, and AI models — three different things in this codebase specifically |
| `lib/` | Same problem as `utils/` |
| `common/` or `shared/` at the top level | Becomes a dependency everything imports, which quietly makes the dependency graph a single node |
| `types/` at the top level | Types belong with the code they describe. A central `types/` becomes a file everything imports and nobody understands |

**The pattern in every exclusion: names that do not constrain what goes in them.**
A directory named for a *responsibility* tells you whether a file belongs there. A
directory named for a *category* ("utils", "common", "shared") accepts anything,
and accepting anything is how a module boundary dissolves.

---

## Migration from the current structure

The existing repository is a conventional Express layout. The mapping:

| Current | Becomes |
|---|---|
| `Backend/routes/chat.js` | `interfaces/http/controllers/*` + `application/chat/*` + `application/threads/*` |
| `Backend/models/Thread.js` | `domain/conversation/Thread.js` + `infrastructure/persistence/mongo/schemas/thread.schema.js` + a mapper |
| `Backend/providers/interfaces/Provider.js` | `domain/ports/ProviderPort.js` + `domain/errors/*` + `infrastructure/providers/shared/BaseProvider.js` |
| `Backend/providers/router/ModelRouter.js` | `domain/routing/RoutingPolicy.js` (pure) + `application/chat/RoutingExecutor.js` (effectful) |
| `Backend/providers/registry/index.js` | `infrastructure/providers/registry/*` |
| `Backend/providers/registry/catalog.js` | `infrastructure/providers/catalog/*` + `domain/capability/*` types |
| `Backend/providers/utils/reliability.js` | `infrastructure/providers/shared/http-client.js` + `domain/routing/CircuitBreaker.js` (pure) |
| `Backend/providers/utils/env.js` | `infrastructure/config/*` |
| `Backend/providers/adapters/*` | `infrastructure/providers/adapters/*` |
| `Backend/server.js` | `main.js` + `container.js` + `interfaces/http/*` |

**The splits, not the moves, are the substance of the migration.** Three files
carry most of the work:

- **`ModelRouter.js` splits in two.** The ranking logic is pure and becomes
  domain; the execution loop performs I/O and becomes an application-layer
  executor. This split is what makes the 20 routing decisions unit-testable.
- **`Provider.js` splits in three.** The interface the domain requires, the error
  taxonomy every layer needs, and the base class adapters extend are three
  different things currently in one file.
- **`reliability.js` splits in two.** `CircuitBreaker` is a pure state machine
  and belongs in the domain; `resilientFetch` is HTTP and belongs in
  infrastructure.

Everything else is largely relocation. Phase 1 ([14](14-roadmap.md#phase-1--domain-core))
performs this migration before any new feature work, because building on the old
structure would mean migrating more code later.
