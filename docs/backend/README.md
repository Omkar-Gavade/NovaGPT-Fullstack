# NovaGPT Backend — Engineering Handbook

This folder is the **single source of truth** for the NovaGPT backend. It is a
planning artifact: it describes the system that will be built, not the system as
it exists today. No implementation code lives here, and no document here should
be treated as optional reading before implementation starts.

The intent is simple: an engineer picking up any ticket in the next 6–12 months
should be able to implement it **without making an architectural decision**. If
a decision is required and it is not in these documents, that is a gap in the
documentation, and the fix is to amend the documentation first.

## Reading order

| # | Document | What it answers |
|---|---|---|
| 01 | [System overview](01-system-overview.md) | What are we building, and why does it exist? |
| 02 | [Architecture](02-architecture.md) | How is the code organised, and what depends on what? |
| 03 | [Provider system](03-provider-system.md) | How does a model provider plug in? |
| 04 | [Router](04-router.md) | How is a model chosen, and what happens when it fails? |
| 05 | [Capability matrix](05-capability-matrix.md) | How does the system know what a model can do? |
| 06 | [Context engine](06-context-engine.md) | How is a conversation turned into a prompt? |
| 07 | [Streaming engine](07-streaming-engine.md) | How do tokens get from a provider to a browser? |
| 08 | [Storage](08-storage.md) | Where does state live, and for how long? |
| 09 | [API design](09-api-design.md) | What is the HTTP contract? |
| 10 | [Security](10-security.md) | Who can do what, and how are secrets handled? |
| 11 | [Observability](11-observability.md) | How do we know the system is healthy? |
| 12 | [Testing](12-testing.md) | What must be proven before a change merges? |
| 13 | [Deployment](13-deployment.md) | How does it run in production? |
| 14 | [Roadmap](14-roadmap.md) | In what order do we build it? |
| 15 | [Decisions (ADR)](15-decisions.md) | Why did we choose this over the alternative? |
| 16 | [Repository structure](16-repository-structure.md) | Where does each file go, and why? |

## Conventions used in these documents

**Every decision states a WHY.** A document that says "we use Redis" without
saying what breaks without Redis has failed its job. Where more than one option
was viable, the alternatives and the trade-off are recorded in
[15-decisions.md](15-decisions.md).

**Diagrams are Mermaid.** They render on GitHub and in most editors, they diff
as text, and they cannot drift into a binary nobody can edit.

**Normative language.** *MUST* / *MUST NOT* are hard rules — breaking one is a
review blocker. *SHOULD* is a strong default that may be overridden with a
recorded reason. *MAY* is genuinely optional.

**Phase labels.** Anything marked *Phase 1* is in scope for the first
implementable release. Anything marked *Later* is deliberately deferred and MUST
NOT be built early — see [14-roadmap.md](14-roadmap.md) for the sequencing and
the reasoning behind it.

## Status of this document set

| Property | Value |
|---|---|
| Phase | Backend planning — design only, no implementation |
| Frontend | Frozen; the API contract in [09-api-design.md](09-api-design.md) is written to what the frontend already consumes |
| Providers in scope | 8 (see [01-system-overview.md](01-system-overview.md#supported-providers-phase-1)) |
| Owner | NovaGPT backend maintainers |
| Change process | Amend the document, record the reasoning in [15-decisions.md](15-decisions.md), then implement |
