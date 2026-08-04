# NovaGPT Chat Workspace — UX Specification

**Scope:** the chat workspace only. Not the landing page, not settings, not billing.
**Audience:** the designer who builds this in Figma, and the engineer who implements it.
**Status of the underlying system:** every behaviour specified here is checked against
what the backend actually returns today. Where a surface would require capability that
does not exist yet, it is marked **[NOT BUILT]** and specified anyway so the design has
somewhere to grow — but it must not ship as if it worked.

---

## 0. The thesis

Nine providers are wired up. The router ranks them on health, priority, tier, latency,
cost, and capability fit, retries transient failures in place, fails over when a provider
dies, and reports which model answered and why.

**All of that is invisible in a chat bubble.**

That is the entire design problem. A multi-model platform that looks like a chatbot *is*
a chatbot with extra ops cost. But the naive fix — surfacing the orchestration — makes the
product worse, because the whole point of automatic routing is that the user should not
have to care.

**The resolution, and the spine of this document:**

> The machinery is silent by default and complete on demand.
> Nothing about routing interrupts the user. Everything about routing is one click away,
> permanently, attached to the message it explains.

Three consequences that decide most arguments later:

1. **Never a toast.** A routing event that matters is part of the transcript record and
   stays there. A routing event that does not matter is not shown at all. Nothing about
   model selection is allowed to be ephemeral — a notification the user missed is worse
   than no notification, because they now have a false model of what answered them.
2. **Route by intent, not by model name.** Users cannot rank forty model IDs. They can
   say "faster", "think harder", "keep this private". Those map cleanly onto the ranking
   chain that already exists.
3. **The receipt is the product.** "Answered by Gemini 2.0 Flash — chosen for a 1M
   context window; Groq was faster but could not fit the thread" is a sentence no
   single-model product can write. It is the moment the platform stops feeling like a
   wrapper.

### What NovaGPT is not

- Not a model marketplace. The user is not shopping.
- Not a dashboard. Telemetry belongs in Grafana, not above the composer.
- Not a control panel. Every knob shown must change an answer the user is about to get.

---

## 1. What the market gets right, wrong, and what to never copy

Observations, not product names.

**Works — steal the principle, not the pixels**

| Pattern | Why it works |
|---|---|
| Composer as the visual centre of an empty state | The first interaction is unambiguous; zero chrome to parse |
| Streaming with a caret | Turns latency into progress; the caret is a *promise*, a spinner is an *apology* |
| Collapsed reasoning traces | Available to the curious, invisible to everyone else |
| Message-hover actions | Keeps the transcript clean while every message stays actionable |
| Conversation list ordered by recency, nothing else | Matches how memory actually works — you look for "the one from Tuesday" |
| ⌘K over navigation | Search scales past any hierarchy a sidebar can hold |

**Fails — do not repeat**

| Pattern | Why it fails |
|---|---|
| A dropdown of 40 raw model IDs | Asks the user to be a model researcher; the single largest cognitive-load failure in the category |
| Auto-scroll that fights the user | Scrolling up to read is a *deliberate* act; yanking them down is the most-complained-about behaviour in every AI chat product |
| Ephemeral toasts for meaningful events | The event is gone before it is read, and unrecoverable afterwards |
| Regenerate with no record of what changed | The user gets a different answer with no idea why, and cannot get the first one back |
| Silent model substitution | Destroys trust permanently the moment it is noticed |
| Nested folders for conversations | A filing tax users refuse to pay; the folders end up empty and the sidebar ends up worse |
| Settings shown before a first message | Configuration before value |
| Fake "Thinking…" on models that expose no reasoning | Theatre. Once a user notices, every other status label is suspect |

**Never copy, at any price**

- **Hiding failover.** If provider A died and B answered, say so, in the transcript,
  forever. The system already reports this (`switched`). Discarding it in the UI would be
  the one decision that turns an honest architecture into a dishonest product.
- **Implying a tool ran when it did not.** The backend returns tool *intent*
  (`executed: false`). Any UI that renders that as a completed action is lying.
- **Citations without retrieval.** No source exists to cite yet. Fabricated provenance is
  worse than no provenance.

---

## 2. Layout

### 2.1 Frame

Three regions, fixed, no user-resizable panes except the sidebar's collapse.

```
┌────────────┬──────────────────────────────────────────────┐
│            │  Thread bar            (56px, sticky)        │
│  Sidebar   ├──────────────────────────────────────────────┤
│  280px     │                                              │
│  collapse  │  Transcript        (scrolls, max 720px col)  │
│  → 60px    │                                              │
│            ├──────────────────────────────────────────────┤
│            │  Composer          (sticky bottom, grows)    │
└────────────┴──────────────────────────────────────────────┘
```

**Rules**

- **One scroll region.** Only the transcript scrolls. Sidebar scrolls independently only
  when its list overflows. The page never scrolls. Two scrollbars in view is a bug.
- **Reading column capped at 720px** regardless of viewport. Beyond ~90 characters per
  line the eye loses its return point. Wide screens get margin, not longer lines.
- **Code and tables may exceed the column** to 900px, and scroll horizontally inside
  themselves. The page body never scrolls sideways.
- **Composer is anchored, not floating.** It sits on the transcript's background with a
  top hairline, not as a card with a shadow. A floating card implies a modal surface;
  this is a permanent part of the frame.

### 2.2 Vertical rhythm

The transcript's bottom padding must equal composer height + 24px, so the last message
is never obscured. Recompute on composer growth — a message hidden behind a grown
composer is the most common layout defect in this product category.

---

## 3. Information hierarchy

Five tiers. Every element in this document is assigned one. If an element cannot be
placed, it does not ship.

| Tier | Name | Contains | Visual treatment |
|---|---|---|---|
| **1** | The answer | Assistant message body, user message text | Highest contrast, largest type, full colour |
| **2** | The conversation | Thread title, message boundaries, timestamps on demand | Normal text colour, standard weight |
| **3** | The controls | Composer, send, attach, intent chip, message actions | Visible on approach; never competing with tier 1 |
| **4** | The receipt | Model attribution, routing reason, token counts, cost | Muted, small, revealed on demand |
| **5** | The exception | Errors, failover notices, capability refusals, limits | Colour-coded, inline, unmissable *when present*, absent otherwise |

**The load-bearing rule:** tier 4 must never occupy tier 1's visual weight. The model name
under a response is 12px and muted, not a coloured badge. The routing detail is behind a
click, not in the layout. A user who never cares which model answered must be able to use
NovaGPT for a year without noticing the machinery — while a user who cares must never
have to ask.

---

## 4. Sidebar

**Purpose.** Get back to a past conversation, and start a new one. That is the entire job.

**Why it exists.** Conversation history is the only navigation this product has. There are
no sections, no documents, no projects. A sidebar that pretends otherwise is inventing
hierarchy to justify its own width.

### 4.1 Structure

```
┌─────────────────────────────┐
│ ✎ New chat            ⌘⇧O   │   ← always first, always visible
│ 🔍 Search             ⌘K    │   ← opens overlay, not inline filter
├─────────────────────────────┤
│ PINNED            (if any)  │
│   • Thread title            │
├─────────────────────────────┤
│ TODAY                       │
│   • Thread title            │
│ PREVIOUS 7 DAYS             │
│   • Thread title            │
│ EARLIER                     │
├─────────────────────────────┤
│ ▸ Avatar   Name    ⋯        │   ← pinned to bottom
└─────────────────────────────┘
```

**Purpose of each element**

| Element | Purpose | Priority | Appears | Disappears |
|---|---|---|---|---|
| New chat | Start fresh without losing the current thread | P0 | Always | Never |
| Search entry | Recall past conversations past the visible window | P0 | Always | Never |
| Pinned group | Keep 3–5 working threads reachable | P1 | Only when ≥1 pin exists | When the last pin is removed |
| Date groups | Make scanning a long list possible | P0 | When threads exist | Empty state replaces them |
| Thread row | The navigation atom | P0 | — | Archived rows leave the list |
| Account footer | Identity, sign out, settings | P2 | Always | Never |

**Interaction**

- **Row click** → load thread. Primary action, whole row is the target (44px min height).
- **Row hover** → reveal a single `⋯` overflow. Not three icons. One.
- **Overflow menu** → Rename, Pin, Share, Duplicate, Archive, Delete. Delete is
  separated by a divider and destructive-coloured; it asks for confirmation *only*
  because it is irreversible, and the confirm names the thread title.
- **Row long-press (touch)** → same overflow as a sheet. Hover-only affordances are
  broken on touch and this is where that rule bites hardest.
- **Active row** → left accent bar 2px + raised surface. Not a full-saturation fill; the
  sidebar is tier 2 and must not out-shout the answer.
- **Title generation** — a thread is titled from its first user message immediately
  (already the backend's behaviour), so no row ever reads "New chat" in history.

**Best practices**

- Order strictly by `lastMessageAt`. Never by created date — the thread you touched an
  hour ago is the one you want, regardless of when it started.
- Truncate titles to one line with ellipsis. Two-line titles halve the number of visible
  threads and double the scan cost.
- **No folders. No tags. No favourites *and* pins.** One organisational primitive (pin),
  plus search. Every additional axis is a decision the user must make on every thread
  forever, in exchange for a retrieval benefit that search already provides.
- Archive removes from the list without deleting; it is reachable only from search
  filters. If a user needs an "Archived" nav item, archive has failed as a concept.
- **Collapsed state (60px rail):** New chat and Search survive as icons; the thread list
  does not. A rail of truncated titles is unreadable — collapsing means "give me the
  space", so give it fully.

### 4.2 Search overlay (⌘K)

**Purpose.** Retrieval at any scale, and the fastest path to any command.

**Why it exists.** Beyond ~30 threads, scanning fails. Search is what makes the "no
folders" decision defensible; without it that decision is negligence.

**Interaction.** Opens centred, dims the workspace, focus in the field. Typing filters
threads by title and message content. Results show thread title + matching snippet with
the term marked. `↑↓` to move, `↵` to open, `Esc` to close. Empty query shows recent
threads — so ⌘K doubles as a fast switcher.

**Also holds commands**, prefixed and visually separated: New chat, Toggle sidebar,
Switch intent, Export thread. One overlay, two jobs, no second palette.

**Priority:** P0. **Best practice:** never block on the network — filter what is loaded
locally first, then merge server results as they arrive.

---

## 5. Chat area

### 5.1 Thread bar

**Purpose.** Say where you are, and hold thread-scoped actions.

**Why it exists.** Without it, two threads are visually identical and the user loses
their place after any interruption.

**Contents, left to right:**
`[sidebar toggle when collapsed] Thread title ⌄ ······ [Share] [⋯]`

- **Title** is inline-editable on click. No modal, no separate rename dialog — the field
  becomes editable in place, `↵` commits, `Esc` reverts.
- **Share** appears only when the thread has ≥1 exchange. Sharing an empty thread is
  meaningless. It is the *only* outward-facing action in the workspace, so it gets an
  explicit confirm step showing exactly what becomes public.
- **`⋯`** holds Export, Duplicate, Archive, Delete.
- **No model selector here.** Model choice is per-message, and belongs in the composer
  where the message is written. Putting it in the header implies a thread-level lock that
  the routing engine does not enforce.

**Priority:** P1. **Attention:** peripheral — noticed on glance, never demanding.

### 5.2 Transcript

**Purpose.** The conversation record.

**Interaction**

- **Scroll follows the stream only while the user is at the bottom.** The instant they
  scroll up, following stops — permanently for that response. This is non-negotiable;
  auto-scroll that overrides the user is the single most-hated behaviour in the category.
- **"Jump to latest" pill** appears bottom-centre when detached during a stream, showing
  the caret is still moving. It disappears on reaching bottom or on stream end.
- **Restoring a thread** returns to the bottom, not the last read position. In a
  conversation the newest content is always the target.
- **Continuous surface** — no card per message, no border between turns. Role is
  distinguished by alignment and background, not by boxes. Boxes at every turn triple the
  visual noise of a long thread.

---

## 6. Message UX

### 6.1 User message

**Purpose.** Show what was asked, verbatim.

**Why it exists.** Without an accurate record, the answer cannot be evaluated.

**Treatment.** Right-aligned, filled bubble, max 80% column width, wraps. Attachments
render as chips above the text inside the same bubble.

**Interaction**

- **Hover → Edit, Copy.** Primary is Edit.
- **Edit** replaces the bubble with a textarea containing the original. Committing
  **forks the conversation**: everything after that point is superseded, and a
  `1/2 ‹ ›` stepper appears on the message so the user can walk back to what they
  originally asked. Destroying subsequent turns silently is data loss.
- **Never** show a model, cost, or token count on a user message. Tier 1 only.

**Priority:** P0. **Attention:** high — it is the question being answered.

### 6.2 Assistant message

**Purpose.** Deliver the answer, and make its provenance available without imposing it.

**Structure, top to bottom:**

```
  ◆ NovaGPT
  <rendered markdown body>                    ← tier 1
  ┈┈┈ on hover: [⧉ Copy] [↻ Retry ⌄] [👍][👎] ← tier 3
  Gemini 2.0 Flash · 1.2s                      ← tier 4, always present, muted 12px
```

- **No avatar bubble per message.** A single small mark at the top of a *turn*, not on
  every message. Repeated avatars down a long thread are pure noise.
- **The attribution line is always present and always quiet.** This is the compromise
  that makes the whole design work: the fact of multi-model is permanently visible, the
  detail of it is permanently one click away, and neither ever interrupts.
- **Clicking the attribution opens the receipt** (§8.3).
- **Retry has a caret**: retry as-is (primary), or *retry with a different intent /
  specific model* (secondary). A retried response replaces the old one but keeps a
  `1/2 ‹ ›` stepper — comparing two answers is the reason a user retries, and discarding
  the first defeats it.

**Best practices**

- Feedback (👍👎) is hover-only and unlabeled until hovered. If it is always visible it
  reads as a demand for evaluation on every message.
- Selection-based actions: selecting text in a response reveals a small "Quote" action
  that inserts the selection into the composer as a blockquote. Cheap to build, and it
  is how follow-up questions are actually asked.

---

## 7. Composer

**Purpose.** Write and send a message, attach files, and declare *how* the answer should
be produced.

**Why it exists.** It is the product's only input. Everything else is response.

### 7.1 Anatomy

```
┌────────────────────────────────────────────────────────┐
│ [attachment chips, when present]                       │
│ Ask anything                                           │
│                                                        │
│ ⊕  ⚡Auto ⌄                                    🎙  ↑    │
└────────────────────────────────────────────────────────┘
   ↑        ↑                                        ↑
  attach   intent chip                              send
```

| Element | Purpose | Priority | Appears | Disappears |
|---|---|---|---|---|
| Textarea | Compose | P0 | Always | Never |
| Attach `⊕` | Add image / PDF | P0 | Always | Never |
| Intent chip | Declare how to answer (§8.1) | P0 | Always | Never |
| Send `↑` | Submit | P0 | Always (disabled when empty) | Becomes **Stop ■** while streaming |
| Attachment chips | Show what will be sent | P1 | When ≥1 attachment | On removal or send |
| Capability hint | Warn that no model can serve this | P2 | On attach, if fleet lacks the capability | On removal |

### 7.2 Interaction

- **Grows from 1 to 8 lines**, then scrolls internally. The transcript's bottom padding
  tracks the growth so the last message never hides.
- **`↵` sends. `⇧↵` newlines.** No setting for this. The inverse is a preference toggle
  that exists only because a product could not commit.
- **Disabled send when empty**, but the button stays present — a control that appears and
  disappears causes layout shift at the most-used spot in the product.
- **While streaming, send becomes Stop.** Same position, same size, no new control. Stop
  keeps the partial response and marks it as stopped; it does not discard it.
- **Paste an image** → becomes an attachment chip. **Drag a file over the workspace** →
  the transcript area shows a dashed inset drop zone, the composer does not move.
- **The composer never clears until the request is accepted.** If send fails, the text is
  still there. Losing a long prompt to a network error is unforgivable and common.

### 7.3 Best practices

- Placeholder is "Ask anything" — a label, not an instruction. Rotating example prompts
  in the placeholder are noise on every subsequent visit.
- Focus is in the composer on thread load and after every response completes.
- Draft text persists per thread. Switching away and back must not lose it.
- **No formatting toolbar.** Markdown is typed. A toolbar implies a rich-text document
  and doubles the composer's height for a feature the audience does not need.

---

## 8. Multi-model UX

This section is the product. Sections 8.1–8.4 are what differentiate NovaGPT from a
wrapper, and they are built on data the backend already returns
(`routing.mode`, `routing.reason`, `switched.reason`, `context`, `usage`, `meta.model`).

### 8.1 Intent chip — routing without model names

**Purpose.** Let the user influence routing using a vocabulary they already have.

**Why it exists.** The category's standard control is a dropdown of raw model IDs, which
demands the user know that one model is stronger at reasoning, another is cheaper, another
has a longer context. They do not, and should not have to. But they *do* have opinions:
this is trivial, answer fast; this matters, take your time; this is confidential.

**The five intents**

| Intent | Means | Maps to the ranking chain as |
|---|---|---|
| ⚡ **Auto** (default) | Let the router decide | Unmodified ranking |
| ⚡⚡ **Fast** | Latency over depth | Weight latency; prefer high-speed tiers |
| 🧠 **Deep** | Depth over latency and cost | Prefer reasoning-capable, larger models; raise thinking budget where supported |
| ◐ **Economy** | Cheapest acceptable | Weight cost band; prefer free tiers |
| ⌂ **Local** | Never leaves this machine | Restrict to Ollama; refuse rather than fall back |

**Interaction.** Click the chip → a compact menu of five intents, each with a one-line
explanation. At the bottom, a divider and **"Choose a specific model →"** for the minority
who want exact control; that opens the full catalog (§8.2). Selection persists for the
thread and shows in the chip.

**Why this ordering matters.** The intent list is the default and the model list is the
escape hatch, not the reverse. Ninety percent of users never open the second level, and
the ten percent who do are the ones who know what they are looking at.

**Local is a posture, not a preference.** When ⌂ Local is active the composer border
takes a distinct treatment and the placeholder reads "Ask anything — stays on this
device". If no local model is reachable, the intent is disabled with the reason, never
silently downgraded to a cloud provider. A privacy promise that quietly fails is a
security incident, not a UX defect.

**Priority:** P0. **Attention:** peripheral until clicked.

### 8.2 Model catalog (second level)

**Purpose.** Exact control for users who want it.

**Why it exists.** Evaluation, reproducibility, and the user who has already decided.

**Interaction.** A searchable list grouped by provider. Each row: display name, provider,
and **capability marks only where they matter** — context window, vision, PDF, tools. A
row for an unavailable model is shown greyed with the reason ("no credential configured",
"provider unreachable") rather than hidden; a model that vanishes from a list looks like
a bug, while a model that explains its absence teaches the user how the system works.

**Best practice.** Never sort alphabetically — sort by the router's own ranking so the
top of the list is the model that would have been chosen anyway. Alphabetical order in a
model list is an admission that the product has no opinion.

### 8.3 The routing receipt

**Purpose.** Answer "why this model?" completely, for anyone who asks.

**Why it exists.** This is the glass box. It converts an invisible architectural
advantage into a visible product one, and it is the single strongest argument that
NovaGPT is a platform rather than a wrapper.

**Appears** on clicking the attribution line. **Disappears** on `Esc`, outside click, or
scroll away. It is a popover anchored to the message — never a modal, never a side panel;
it explains *this* answer and must stay next to it.

**Contents**

```
Answered by
  Gemini 2.0 Flash · Google

Why
  Automatic. Chosen for a 1M-token context window;
  the thread needs 47k and no faster model could hold it.

Context
  47,200 of 1,000,000 tokens   ▓▓░░░░░░░░  5%
  32 messages sent · 4 dropped as too old

Cost
  1,204 in · 890 out · $0.0004

  [Retry with a different model]
```

Every line here is already available: `routing.mode`, `routing.reason`,
`context.estimatedTokens`, `context.promptBudget`, `usage`, `meta.model`.

**Best practice.** The "Why" sentence must be written by the router, not composed by the
client from flags. A client that writes its own explanation will eventually explain a
decision that was made differently.

### 8.4 Failover notice

**Purpose.** Tell the user their answer came from somewhere other than the first choice.

**Why it exists.** The system already fails over on `quota`, `rate_limit`, `timeout`,
`outage`, and `auth`. Concealing it means a user comparing two answers has no idea they
came from different models — and the day they find out, every previous answer becomes
suspect.

**Appears** inline, immediately above the assistant message, whenever `switched` is
present. **Never disappears** — it is part of the record and persists in history.

**Form:** one muted line with a small diverging-arrow glyph.
> ⤳ Groq timed out. Answered by Gemini 2.0 Flash.

Tier 5, but the quiet end of it. Not a red banner — nothing went wrong, the system did
exactly what it was built to do. It is an amber-neutral note, not an alarm. Clicking it
opens the same receipt with the failure chain expanded.

**This is a signature moment.** Done right, the user's reaction is "it handled that" —
which is a thing no single-provider product can ever produce.

### 8.5 Second opinion **[NOT BUILT — highest-value addition]**

**Purpose.** Ask the same question of a second model and compare.

**Why it exists.** It is the only feature in this document that is *impossible* without a
multi-model platform, and it turns the architecture into a user-facing reason to choose
NovaGPT. Everything else here is better execution of a familiar idea; this is a different
product.

**Interaction.** In the assistant message overflow: **"Get a second opinion"**. The
response area splits into two columns, each with its own attribution line, streaming in
parallel. The user keeps one (`Keep this`), and the discarded one collapses into a
`compared with GPT-class model ⌄` note on the kept message — so the comparison survives
in the record without cluttering it.

Below 900px the columns stack, with a sticky segmented control to switch between them.

**Requires:** a client that can hold two concurrent streams for one logical turn, and a
transcript model where a turn may hold multiple candidate responses. Specify now, build
after Phase 13.

### 8.6 What is deliberately *not* in the chat workspace

- Provider health dashboards, uptime indicators, latency graphs. If a provider is down,
  the router routes around it; the user's only legitimate interest is *their* answer.
- Per-message cost as a persistent label. Cost lives in the receipt and aggregates in a
  usage view. A running money counter above the composer makes every message feel
  expensive and suppresses use.
- A provider logo wall. Rainbow chrome makes the product look like an aggregator.
  NovaGPT's brand is that you don't have to think about providers.

---

## 9. Streaming

**Purpose.** Make a multi-second wait feel like progress rather than latency.

**Why it exists.** Perceived speed is a product quality. The same 6-second response feels
fast when it starts at 300ms and slow when it arrives whole at 6s.

**The state sequence**, mapped to the SSE contract (`stream` → `delta`… → `done` | `error`):

| State | Trigger | UI |
|---|---|---|
| Submitted | Send pressed | User message appears **immediately**, optimistically. Composer clears. Send → Stop. |
| Connecting | `stream` frame pending | Assistant turn mark appears with a three-dot pulse where text will go |
| Streaming | first `delta` | Dots replaced by text + a blinking caret. Content grows. |
| Complete | `done` | Caret removed, attribution line fades in, actions become hoverable |
| Stopped | user pressed Stop | Caret removed, partial text kept, muted "Stopped" note, Retry offered |
| Failed | `error` | §14 |

**Best practices**

- **Optimistic user message.** It must appear before any network round-trip. A user
  message that waits for the server makes the whole product feel sluggish at the exact
  moment first impressions form.
- **The caret is the loading indicator.** No spinner anywhere near the response. A
  spinner says "nothing is happening"; a caret says "it is happening now".
- **Never render partial markdown syntax.** Buffer to the end of a construct before
  committing it — an unclosed ``` or half a table flashing raw asterisks is the cheapest
  possible way to look broken. Render the completed prefix, hold the incomplete tail.
- **Do not re-highlight code on every token.** Render streaming code as plain monospace;
  apply syntax highlighting once the fence closes. Highlighting per token is the most
  common cause of jank in this UI.
- **Frame budget:** batch deltas to one paint per animation frame. Token-by-token DOM
  writes destroy scroll performance on long threads.
- **Stop must be instant** — abort locally the moment it is pressed, do not wait for the
  server to acknowledge.

---

## 10. Thinking state

**Purpose.** Represent a model reasoning before it answers, where the model actually does.

**Why it exists.** Deep intent will route to reasoning-capable models with a raised
thinking budget. Without a representation, those responses look frozen for many seconds.

**Interaction.** A single collapsed row above the response:

> ⌁ **Thinking…** *(live, while reasoning)*
> ⌁ **Thought for 6s** ⌄ *(after, collapsed, click to expand)*

- **Always collapsed by default.** Reasoning traces are long, repetitive, and
  occasionally alarming out of context. The user asked a question, not for a monologue.
- Expanded, the trace renders in a muted, smaller, indented block — visually
  subordinated to the answer so it can never be mistaken for it.
- Collapse state persists per thread as a preference: a user who expands three in a row
  wants them expanded.

**Hard rule.** Show this **only** when the provider genuinely returns reasoning content.
If it does not, show nothing at all — the ordinary streaming caret covers the wait. A
fabricated "Thinking…" on a model with no reasoning output is theatre, and the first user
who notices stops believing every other status in the product.

**[NOT BUILT]** The SSE contract carries `stream` / `delta` / `error` / `done` today. A
`reasoning` frame type is required before this can ship. Specified so it is designed once.

**Priority:** P2 — high value, only for Deep intent.

---

## 11. Attachments

Backend reality: images and PDFs are ingested, sniffed from magic bytes, and routing
derives the required capability from the *content*, not the client's label. A request
that needs vision cannot reach a text-only model. The UI's job is to make that legible.

### 11.1 Attachment chip

**Purpose.** Show what will be sent before it is sent.

**Interaction.** Appears in the composer on attach. Thumbnail for images, page-count for
PDFs, filename, size, and a remove `×`. Click opens a preview. Removal is instant, no
confirm — it has not been sent yet.

**States:** uploading (progress on the chip itself, not a separate bar) → ready →
rejected (inline reason on the chip: too large, unsupported type, unreachable URL).

### 11.2 Capability hint

**Purpose.** Say *before sending* that no configured model can read this.

**Why it exists.** The backend refuses with `unsupported_capability` and names the
capability. Surfacing that at attach time instead of after send saves the user a
round-trip and teaches them what their deployment can do.

**Appears** the moment an attachment is added whose capability the fleet lacks.
**Form:** one line under the chips — "No configured model can read PDFs. [See models]".
Send stays enabled — the user may still want to send the text.

### 11.3 Images

- In the user bubble: max 320px on the long edge, rounded, click for a lightbox.
- Multiple images: a 2-column grid inside the bubble, capped at 4 visible with `+n`.
- Alt text is mandatory on every rendered image; use the filename when nothing better
  exists.

### 11.4 PDFs

- Never render the document inline. A page-1 thumbnail + filename + page count, clicking
  opens the browser's own viewer in a new tab. An embedded PDF viewer in a chat
  transcript is a large amount of work to make the conversation harder to scroll.
- If the PDF is long enough that only part fits the context window, say so on the chip:
  "42 pages · first 20 sent". Silent truncation makes the model look wrong when it is
  the context budget that was.

### 11.5 Persistence

Payloads are stripped before storage (they are re-uploaded to nothing and would blow the
document limit) but the *fact* of the attachment survives. In restored history, chips
render with the filename and type but no thumbnail, and a hover explains: "Preview not
retained." Do not render a broken image.

---

## 12. Code blocks

**Purpose.** Make code readable, copyable, and unmistakably distinct from prose.

**Why it exists.** It is the single most-used artifact type in a developer-facing AI
product, and the most-repeated user action in the entire workspace is "copy that".

**Anatomy:** header bar (`language` · `filename if known` · [⧉ Copy] [⤢ Wrap]), then the
code, mono, 13px, 1.5 line-height, subtle numbering only past 10 lines.

**Interaction**

- **Copy is the primary action and is always visible on desktop** — not hover-revealed.
  This is the deliberate exception to the hover rule, justified by frequency.
- Copy confirms in place: the icon becomes a check for 1.2s. No toast.
- Wrap toggles between horizontal scroll and soft wrap, remembered globally.
- Long blocks (>24 lines) collapse to 24 with a "Show all (140 lines)" affordance.
- Inline `code` gets a subtle background and the same mono face, no border.

**Best practices**

- Highlight after the fence closes, never during (§9).
- The block may exceed the 720px reading column to 900px, and scrolls inside itself.
- **No Run button.** The product cannot execute code; an affordance that implies it can
  is a lie the first click exposes.

---

## 13. Citations **[NOT BUILT — Phase 13]**

**Purpose.** Attribute a claim to a retrieved source.

**Why it exists.** Once retrieval exists, an unattributed answer over the user's own
documents is unverifiable and therefore unusable for anything that matters.

**Specified now so it is designed once:**

- Inline marker `[1]` at the end of the *claim*, not the paragraph — the sentence is the
  unit of verification.
- Hovering a marker previews the source snippet; clicking scrolls to a compact source
  list beneath the message.
- The source list is collapsed by default, headed "3 sources".
- A response using retrieval that produced *no* usable source must say so explicitly:
  "Answered without sources." Ambiguity here is worse than absence.

**Hard rule.** No part of this ships before retrieval exists. Rendering citation
affordances over a model's unsourced output would be the most damaging possible thing to
build.

---

## 14. Error states

Six error kinds exist in the system. Each gets one sentence in plain language, an action,
and a place — **inline, at the point of failure, never a modal, never a toast**.

| Kind | What the user sees | Action |
|---|---|---|
| `rate_limit` | "You're sending messages faster than the limit. Try again in 30s." | Retry, auto-enabled at zero |
| `quota` | "This provider's quota is used up. NovaGPT will use another." | Retry |
| `timeout` | "That took too long. NovaGPT already retried once." | Retry |
| `outage` | "Every configured model is unavailable right now." | Retry |
| `auth` | "This provider rejected NovaGPT's key." | Check keys → settings |
| `api_error` | "That request was rejected: {reason}." | Edit message |
| `unsupported_capability` | "No configured model can read PDFs." | See models |

**Rules**

- The failed turn **stays in the transcript** with the error attached beneath the user's
  message. Removing it loses the prompt.
- **Retry is always the primary action**, in place, without retyping.
- A trace ID is present but subordinate — a small "Copy details" in the error's overflow,
  not a hex string in the user's face.
- **Never show a provider's raw error text.** It leaks internals and means nothing to the
  user. `api_error` is the one exception, because the reason is about *their* request.
- Distinguish "we already retried" from "you may retry". The system retried
  transparently; saying so converts a failure into evidence of robustness.

---

## 15. Loading and empty states

### 15.1 Empty workspace (no threads)

**Purpose.** Get to a first message in one action.

**Composition:** centred, composer at optical centre (~40% viewport height, not 50% —
geometric centre reads as low). Above it, the product name and one line of positioning.
Below it, **three example prompts chosen to demonstrate the platform, not the chatbot** —
one long-document task, one image task, one reasoning task. Clicking one fills the
composer; it does not send. The user should see what they are about to ask.

Nothing else. No feature tour, no settings prompt, no provider list.

### 15.2 Empty thread (new chat, threads exist)

Composer stays at the bottom — the frame does not rearrange, because the user is already
oriented and moving the composer would be disorienting. Above it, one muted line only.
No example prompts on a returning user's second thread; they know what this is.

### 15.3 Thread loading

Skeleton rows matching real message geometry (alternating widths, right- and
left-aligned), for up to 400ms. Beyond that, keep the skeleton — never swap a skeleton
for a spinner, that reads as a failure. The sidebar and composer render immediately and
are usable while the transcript loads.

### 15.4 Sidebar loading

Six skeleton rows. Never a spinner, never an empty box, never a layout that reflows when
content arrives — reserve the exact height.

---

## 16. Keyboard shortcuts

**Purpose.** Make the workspace fast for the people who use it most.

**Why it exists.** Power users are the ones who evaluate a platform, and keyboard depth
is a strong premium signal at near-zero visual cost.

| Shortcut | Action |
|---|---|
| `⌘K` | Search & command overlay |
| `⌘⇧O` | New chat |
| `⌘/` | Shortcut reference |
| `⌘B` | Toggle sidebar |
| `↵` | Send |
| `⇧↵` | Newline |
| `Esc` | Close overlay → stop stream → blur composer, in that order |
| `⌘↑` | Edit last user message |
| `⌘⇧C` | Copy last response |
| `⌘⇧R` | Retry last response |
| `⌘⇧M` | Open intent chip |
| `⌘⇧⌫` | Delete current thread (confirms) |
| `↑ / ↓` | Move in overlay results |

**Best practices**

- Every shortcut has a non-keyboard equivalent. Shortcuts are an accelerator, never the
  only path.
- Show the shortcut in the tooltip of the control it accelerates — that is how they are
  learned, not from a reference sheet.
- `Esc` must be predictable and layered, exactly as ordered above.
- Never bind a browser-reserved combination.

---

## 17. Micro-interactions and motion

**Purpose.** Communicate causality and state change. Nothing else.

**Why it exists.** Motion that explains where something came from reduces cognitive load.
Motion that decorates increases it and makes a fast product feel slow.

| Interaction | Duration | Curve | Purpose |
|---|---|---|---|
| Message enters | 180ms | ease-out, fade + 4px rise | Marks arrival without drawing the eye away from text |
| Hover actions reveal | 100ms | linear opacity | Fast enough to feel attached to the pointer |
| Attribution line after `done` | 200ms fade, 80ms delay | ease-out | Signals completion; the delay prevents it competing with the last token |
| Sidebar collapse | 200ms | ease-in-out, width | Spatial continuity |
| Overlay open | 150ms | ease-out, fade + 0.98→1 scale | Establishes a layer above |
| Overlay close | 100ms | ease-in | **Exit faster than enter** — the user has decided, do not make them wait |
| Copy confirmation | instant → 1.2s hold | — | Confirmation must be immediate to feel like a result |
| Caret blink | 1s steady | step | Progress |
| Failover notice | 200ms fade, no motion | ease-out | Present, not alarming |

**Rules**

- **Nothing animates longer than 250ms.** Above that the interface waits on itself.
- **Animate only `transform` and `opacity`.** Animating width/height/top triggers layout
  and produces the jank this product cannot afford during streaming.
- **`prefers-reduced-motion` removes all movement**, keeping opacity changes only. This
  is an accessibility requirement, not a nicety.
- **No hover animation on the transcript.** Movement while reading is hostile.
- Skeletons pulse; they do not shimmer-sweep. A sweep animation across a loading list is
  decoration pretending to be progress.

---

## 18. Responsive behaviour

| Breakpoint | Layout |
|---|---|
| ≥1280px | Sidebar 280px, reading column 720px, wide margins |
| 1024–1280px | Sidebar 260px, column flexes to fill |
| 768–1024px | Sidebar collapses to rail by default; expands as an overlay over the transcript |
| <768px | Sidebar becomes a full-height sheet from the left; thread bar gains a menu button |

**Mobile specifics**

- Composer is sticky above the keyboard, using visual-viewport (not window) height. This
  is the single most-broken thing in mobile web chat.
- **No hover-only affordances.** Message actions become a persistent low-contrast row or
  a long-press sheet. Everything reachable by hover on desktop must be reachable by a
  deliberate touch.
- Minimum target 44×44px with ≥8px separation.
- Respect safe-area insets top and bottom.
- The intent chip stays in the composer — it is a primary control, not a secondary one,
  and it must not be exiled to an overflow on the platform where careless model choice
  costs the most.
- No horizontal page scroll ever. Code and tables scroll inside themselves.

---

## 19. Accessibility

Non-negotiable, and cheap if designed in rather than retrofitted.

- **Contrast:** 4.5:1 body, 3:1 large text and UI boundaries. This directly constrains
  tier-4 muted text — the attribution line must be muted *and* legible; a 2.8:1 grey is
  not a design choice, it is a defect.
- **Streaming and screen readers:** the response container is `aria-live="polite"` but
  **must not announce every token** — announce "Response started", then the complete text
  on `done`. Per-token announcement makes the product unusable with a screen reader.
- **Focus:** visible ring on every interactive element, never removed. On overlay open,
  focus moves in and is trapped; on close, it returns to the trigger. After a response
  completes, focus returns to the composer.
- **All icon-only controls carry `aria-label`.** Attach, send, stop, copy, overflow,
  sidebar toggle.
- **Order:** the DOM order is sidebar → thread bar → transcript → composer, with a skip
  link to the composer as the first tab stop. A keyboard user must not tab through fifty
  messages to reach the input.
- **Colour is never the only carrier.** The failover notice has a glyph and text; errors
  have an icon and text; unavailable models say why in words.
- **Semantic roles:** the transcript is a `log`; messages are `article`s with an
  accessible name naming the speaker.

---

## 20. Design system principles

Six rules the whole workspace obeys.

1. **One accent colour.** Used for the send button, the active thread bar, and focus
   rings. Nothing else. An interface with one accent has an unmistakable primary action
   on every screen.
2. **Provider colours are data, never chrome.** They may appear as a 8px dot in the model
   catalog. They never colour a message, a border, or a badge. The product's promise is
   that you stop thinking about providers; painting the UI in their brands breaks it.
3. **Surface, not borders.** Depth comes from 3 background elevations. Borders are 1px
   hairlines used only to separate regions (composer top, code header). A UI of boxes
   inside boxes is the default failure mode of a chat product.
4. **Type scale of five.** 12 (tier 4), 14 (UI), 15/16 (body), 20 (thread title), 28
   (empty state). One text face plus one mono face. More sizes than this and the hierarchy
   stops being readable as hierarchy.
5. **Spacing on a 4px grid**, with 8/12/16/24/32 doing almost all the work. Message
   vertical rhythm: 24px between turns, 8px within a turn.
6. **Semantic tokens only.** `--surface-raised`, `--text-muted`, `--accent`, never a raw
   hex in a component. Dark and light are two token sets, not two stylesheets — and dark
   mode is the default, because this is a workspace people sit in.

**Dark-mode specifics:** never pure black (#000) — it makes elevation impossible and
haloes text. Never pure white body text. Elevation raises luminance; it does not add
shadows, which are nearly invisible on dark surfaces.

---

## 21. Simplification pass — what I cut from my own design

A specification that only adds is not a design. Everything below was in an earlier draft
of this document and has been removed. The removals are as much a part of the deliverable
as the components, because each one is an argument that will be re-litigated later.

| Removed | Why it had to go |
|---|---|
| **Persistent context meter above the composer** | A progress bar that reads 4% for the entire life of most threads. It trains the user to ignore it, so it fails at the one moment it matters. **Kept instead:** the meter lives in the receipt, and surfaces in the composer *only* above 75%, where it becomes actionable. |
| **Provider status strip in the sidebar** | Users cannot act on it. The router already routes around a dead provider. It converts a solved problem into visible anxiety. |
| **Per-message cost label** | A money counter on every response suppresses use of the product. Cost belongs in the receipt and in an aggregate usage view. |
| **Model selector in the thread bar** | Duplicated the intent chip and implied a thread-level lock the router does not enforce. Two controls for one decision is worse than either alone. |
| **Folders, tags, and favourites** | Three organisational axes, each a decision on every thread forever, all solved better by pins + ⌘K. Kept exactly one primitive. |
| **Separate command palette** | ⌘K was going to be search and ⌘P commands. Two overlays, one mental model, no benefit. Merged. |
| **Message-level timestamps** | Noise on every message to answer a question asked once per thread. Now on hover only. |
| **"Regenerate" *and* "Retry" as separate actions** | The same action with two names. One action, with a caret for "differently". |
| **Streaming progress percentage** | Unknowable — the model does not know how long its answer will be. A fake percentage is worse than a caret. |
| **Onboarding tour** | The workspace is a composer and a list. A product that needs a tour to explain a text field has a different problem. |
| **Avatar on every message** | Repeated identical marks down a thread. One mark per turn. |
| **Toasts, entirely** | Every event they were carrying either belongs in the transcript permanently or does not belong at all. There is no toast layer in this product. |
| **An embedded PDF viewer** | Weeks of work to make the conversation harder to scroll. Hand it to the browser. |
| **Run button on code blocks** | The product cannot execute code. |

**What survived the pass, and why each earns its place**

Sidebar (recall), composer (input), transcript (record), intent chip (the routing control
the whole platform hangs on), attribution line (permanent, quiet proof of multi-model),
receipt (the glass box), failover notice (trust), streaming caret (perceived speed),
thinking row (only where real), attachments (a shipped capability), code header (the most
repeated action), inline errors (recovery in place), ⌘K (what makes "no folders" honest).

Thirteen components. Every one of them either takes input, shows output, or explains a
decision the system made on the user's behalf. Nothing decorates.

---

## 22. Honest capability ledger

The designer must know which screens describe a working system and which describe an
intention. Designing the second as if it were the first is how a product ships lying.

| Surface | Backend today |
|---|---|
| Chat, threads, history, titles | **Built** |
| Streaming (`stream`/`delta`/`done`/`error`) | **Built** |
| Automatic routing + `routing.reason` | **Built** |
| Manual model pin, unknown-pin fallback reported | **Built** |
| Failover + `switched.reason` | **Built** |
| Context report (`estimatedTokens`, `promptBudget`) | **Built** |
| Usage / cost per message | **Built** |
| Model catalog with live availability | **Built** |
| Images (vision) end to end | **Built** |
| PDF end to end | **Built** |
| Structured output, server-validated | **Built** (no UI needed) |
| Embeddings | **Built** (API only) |
| BYOK, per provider | **Built** (settings, out of this scope) |
| Local inference (Ollama) | **Built**, unverified against a live daemon |
| Tool calling | **Built as intent only** — returns `executed: false`. Any UI must render a *proposed* action, never a completed one |
| Reasoning / thinking traces | **Not built** — needs a `reasoning` SSE frame |
| Memory | **Not built** — Phase 13 |
| Retrieval / RAG / citations | **Not built** — Phase 13 |
| Context compression | **Not built** — Phase 13 |
| Second opinion (parallel models) | **Not built** — needs multi-candidate turns |

**Contract additions this specification requires**, in priority order:

1. `reasoning` SSE frame type (thinking state)
2. Structured `routing.alternatives` — what was considered and rejected, for the receipt's
   "Why" to be complete rather than a single sentence
3. Multi-candidate turn model (second opinion)
4. Retrieval sources on a message (citations)

---

## 23. Final blueprint — build order for Figma

Frames to produce, in the order that lets each be reviewed before the next depends on it.

**Foundations (build first, nothing else is stable without them)**
1. Token sheet — colour (dark + light), type scale of five, 4px spacing scale, elevation,
   radii, motion durations
2. Component library — button (3 variants), icon button, input, chip, menu, popover,
   overlay, skeleton, tooltip

**Core frames**
3. `Workspace / Empty — first run` (no threads)
4. `Workspace / Empty — returning` (threads exist, new chat)
5. `Workspace / Active thread` (the canonical frame; 3 exchanges, one with code)
6. `Workspace / Streaming` (caret mid-response, Stop state, jump-to-latest pill)
7. `Workspace / Loading` (skeletons: sidebar + transcript)

**Multi-model — the differentiating set, review these hardest**
8. `Routing / Intent chip open` (five intents + the escape hatch)
9. `Routing / Model catalog` (grouped, ranked, unavailable rows with reasons)
10. `Routing / Receipt popover` (all four blocks, anchored to a message)
11. `Routing / Failover notice` (inline, in a real transcript)
12. `Routing / Local mode active` (composer treatment + placeholder)

**Content**
13. `Message / Code block` (header, copy-confirmed state, collapsed long block)
14. `Message / Markdown specimen` (headings, lists, table, blockquote, inline code — one
    frame that pins down every element so it is never improvised)
15. `Message / Attachments` (image grid, PDF chip, capability hint, restored-no-preview)
16. `Message / Thinking` (collapsed + expanded) **[not built — design only]**
17. `Message / Edit and fork` (textarea state + `1/2` stepper)

**States**
18. `States / Errors` (all seven, in-transcript)
19. `States / Search overlay` (results + commands + empty)

**Responsive**
20. `Responsive / Tablet` (rail + overlay sidebar)
21. `Responsive / Mobile` (sheet sidebar, composer above keyboard, touch action row)

**Deferred until the backend catches up — do not design yet**
`Second opinion (split)`, `Citations`, `Memory`.

### The one-paragraph brief for whoever builds it

A single reading column on a quiet dark surface, a composer that never moves, and a
sidebar that only remembers. Under every answer, one muted line naming the model that
produced it — always there, never loud, always clickable into a full explanation of why
that model and what it cost. When a provider fails, a single grey line in the transcript
says so and stays there. The user picks *how* to answer, not *what* answers: fast, deep,
cheap, local, or leave it to NovaGPT. Everything else is text, and the text is the product.

---

*Specification ends. Every behaviour above is either checked against the running backend
or explicitly marked as not built.*
