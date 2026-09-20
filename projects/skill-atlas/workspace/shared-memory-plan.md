# Shared team memory — plan for review, 20 August 2026

Draft 2 of the work record, reframed. Draft 1 (`SCHEMA.md`, `schema.sql`) built a
shared log of what people did. This adds the four things that turn a log into a
memory layer: a **source** the memory is attached to, a **promotion** path from
one person's session into the shared tier, **routing** so it reaches whoever
needs it without anyone asking, and a **sensitivity** axis separate from
audience.

Nothing here is built yet. This is the document to argue with before any code.

---

## Read this first — what I could not verify

I could not open `ddutche/claude-comms` or the ddutche Supabase in this session.
The active GitHub token is the Ddottimate one and cannot see a private ddutche
repo; switching accounts and the Supabase call were both refused by the
permission layer.

So everything below is a **proposal measured against the local prior art in this
folder**, not a delta against what already exists in `claude-comms`. If that repo
already names things differently, the names here lose and the reasoning stays.
Three specific things need reconciling before anything is applied:

1. Whether `work_records` (or its successor) already exists in the ddutche
   database, and under what name.
2. Whether `people` is still `id text primary key` with `email` and `team`.
3. Whether the Cloudflare OAuth gateway in `gateway/` is deployed against the
   ddutche Supabase or was left pointed at the old project.

---

## Two rules carried forward, and one new one

The first two are from `SCHEMA.md` and still hold:

**Structured, not prose.** A typed record can be queried; "worked on the Acme
thing" cannot.

**Writing has to be nearly free.** Recording that is a separate step people have
to remember produces an empty system inside two weeks.

The new one, which this draft is bent around:

**Reaching the right person has to be free too.** Draft 1 assumed people would
come and look. They will not. A shared memory that sits in a table until somebody
searches for it is a wiki, and wikis are exactly the thing that failed at this
already. The unit of value is not the stored memory, it is the *delivered* one —
which is why routing is a first-class part of the schema and not a feature bolted
on later.

The corollary, and the failure mode that kills this: **a routing system that
delivers too much gets muted, and a muted channel protects nothing.** Same shape
as the scanner lesson in `STATE.md` — a scanner people route around protects
nothing. Deliberate restraint on what gets pushed is in the design below, not
left to tuning.

---

## 1. The unit of shared memory

One table, `memory_units`. It replaces `work_records` rather than sitting beside
it — two tables would mean two write paths and a permanent question about which
one a thing belongs in. The existing columns keep their meaning and their
reasoning; the new ones are listed separately so the delta is reviewable.

### Kept from draft 1, unchanged

| field | why it survives |
|---|---|
| `occurred_at` / `recorded_at` | An agent writing up a week of work would otherwise stamp it all as today. |
| `person_id` | Always a person. An agent acts on someone's behalf. |
| `team` | Stamped at insert. A record is a historical fact and must not move when its author changes teams. |
| `summary` (≤300) / `detail` | The cap is a design constraint. Summaries are scanned; an unbounded one becomes a wall. |
| `subject` | The join key. Slug-constrained. Still the field most likely to go wrong. |
| `artifacts` jsonb | Links nothing queries inside of. |
| `status` / `blocked_on` / `needs_from` | Unchanged. |
| `supersedes` | "Current" stays derived, never maintained. |
| `confidence` (`stated`/`observed`/`inferred`) | The clearest differentiator available. Everyone else shipping agent memory has no account of what happens when a memory is wrong. |
| `tags`, `keywords`, `search` | Unchanged, including the `array_to_string` trigger workaround. |

### Changed

**`kind` gains exactly one value: `constraint`.**

A rule that must hold in future work — "the webhook handler is already
idempotent, do not add a dedupe layer", "this endpoint rate-limits at 10/s".
Every gotcha in `STATE.md` is one of these.

It is worth its own value rather than folding into `learned` because the two
route differently. A `learned` is descriptive and gets *pulled* when someone
searches. A `constraint` is prescriptive and gets *pushed* at whoever is about to
touch the thing it constrains. If they share a kind, the routing rule cannot tell
them apart and either pushes too much or pushes nothing.

The seven: `produced`, `shipped`, `decided`, `learned`, `constraint`, `blocked`,
`asked`.

I considered and rejected `context` (background needed to work on something).
`learned` already covers it, and the argument in `SCHEMA.md` for a small closed
set is right — seven is near the ceiling of what someone holds in their head
while choosing one.

**`visibility` splits into two orthogonal columns.** See §4. This is the change
that cannot be retrofitted, so it is in this draft rather than a later one.

### New

| field | what it is | why |
|---|---|---|
| `state` | `candidate` \| `shared` \| `retired` | The promotion lifecycle. A candidate is not searchable and is not routed. This is what lets an agent flag something at zero cost. |
| `scope_type` | `person` \| `team` \| `project` \| `service` \| `org` | Audience. `team` alone cannot express "everyone who touches the payments service", which is the scoping engineers actually want. |
| `scope_id` | text, references `scopes` | The specific team/project/service. |
| `sensitivity` | `normal` \| `confidential` \| `restricted` | Handling, separate from audience. See §4. |
| `origin_vendor` | text, e.g. `anthropic` | Which AI system produced it. **Text, not an enum** — vendors are data, and an enum here is exactly the hard-coding to avoid. |
| `origin_agent` | text | The specific product, e.g. `claude-code`. |
| `origin_ref` | jsonb | Vendor-specific session identifiers. Nothing in the core queries them; they exist so a memory can be traced back. This jsonb is the *only* place a Claude-shaped fact is allowed to live. |
| `promoted_from` | uuid, self-ref | The candidate this was promoted from, if any. |
| `promoted_by` | text → `people` | Who promoted it. Distinct from `person_id`: a reviewer can promote an author's memory. |
| `promoted_at` | timestamptz | |
| `verified_at` / `verified_by` | | Closes the "no verification" gap `SCHEMA.md` left open. |
| `expires_at` | timestamptz, null | Optional. Some constraints are true until a migration lands and false after. |

### Source — a separate table, `memory_sources`

The single most important addition, and the one the whole product rests on.

```
memory_id, source_system, source_kind, source_ref, source_url, relation
```

Separate from `memory_units` for three reasons: one memory legitimately binds to
several sources (a PR *and* the ticket it closes *and* the incident that prompted
both); routing joins on `(source_system, source_kind, source_ref)` and needs that
indexed; and `source_system` must be **text, not an enum**, because Jira, GitHub,
PagerDuty, Linear and whatever comes next are data, not vocabulary.

`source_kind` is a small closed set — `ticket`, `pull_request`, `incident`,
`commit`, `document`, `channel` — because routing rules are written against it.
`relation` says how the memory relates: `about`, `produced`, `caused_by`.

**This binding must be inferred, never typed.** If an engineer has to tell the
tool which ticket they are on, they will not, and routing degrades to nothing.
Claude Code already knows the repo, the branch, and the commit; a branch called
`feature/PROJ-123-retry-backoff` yields the ticket, `git remote` yields the repo,
and `gh pr view` yields the PR. All local, all vendor-neutral, all free. **Routing
quality is entirely downstream of source-binding quality, and source binding has
to cost nothing.** If one thing in this plan gets built well, it is this.

---

## 2. Promotion — personal to shared

Three paths, deliberately different in cost, because the friction that matters is
different in each case.

**`/share` — the one action.** A zero-argument slash command in Claude Code. The
agent reads back over the session, drafts a unit — kind, summary, subject, scope,
sources inferred from the git context — and shows it. One confirm. The engineer
types six characters and answers one question. Anything more than that and the
number of shared memories per week is zero.

**`remember_shared` — the agent writes unprompted.** An MCP tool the assistant
calls as a side effect of doing the work, the way `record_work` is written to be
called today. The tool description carries the instruction to call it without
being asked, which is the only thing that made draft 1's write path plausible.

**`flag_candidate` — free, no confirmation.** Writes `state = 'candidate'`. Not
searchable, not routed, no fields beyond a sentence and the inferred source. This
is the pressure valve: an agent that is unsure whether something is worth sharing
should flag rather than skip, because a candidate costs nothing and a skipped
insight is gone. Candidates surface at session end, or on `/share` with no
argument, as "three things from this session look shareable — any of them?"

**What promotion is not.** It is not a copy from a personal store into a shared
one. There is no separate personal store — `scope_type = 'person'` is the
personal tier, and promotion is a scope change plus a `promoted_by` stamp on the
same row. Two stores would mean reconciling them forever.

**Default scope stays `team`,** for the reason `SCHEMA.md` already argued:
`person` by default is safer and produces an empty, useless system. That default
is only defensible because the write path actively classifies sensitivity rather
than trusting it (§4).

---

## 3. Routing

Derived, never a stored access list. Two tables.

### `memory_subscriptions` — who cares about what

```
person_id, source_system, source_kind, source_ref, reason, active_from, active_to
```

`reason` is `assignee`, `reviewer`, `reporter`, `on_call`, `watcher`, or
`manual`. Written by adapters listening to the external systems: a Jira webhook
on assignment, a GitHub webhook on `review_requested`, a PagerDuty webhook on
on-call handoff.

Time-bounded on purpose. Assignment changes, and a subscription that never
expires turns into a permanent firehose for whoever once touched a ticket.

### `memory_deliveries` — the ledger

```
memory_id, person_id, reason, channel, delivered_at, acknowledged_at, suppressed_reason
```

Three jobs, all necessary. Idempotency, so nothing is delivered twice. The audit
trail the product promises. And measurement — without `acknowledged_at` there is
no way to tell whether routing is helping or being ignored, and no basis for
tightening what gets pushed.

### The two directions

**Forward — new memory to existing subscribers.** On insert of a `shared` unit, a
trigger writes rows to an outbox. A worker drains it. Deliberately not
synchronous: fan-out inside the write request makes the write slow and couples
recording to delivery, and recording must never fail because a delivery target is
down.

**Backward — new subscriber to existing memories.** This is the one that actually
delivers the product claim, and it is the direction people forget to build. When
a ticket is reassigned, the new assignee gets everything bound to that ticket.
When a review is requested, the reviewer gets everything bound to the PR, plus
everything bound to the ticket the PR closes, plus the author's `decided` and
`constraint` records on that subject. That is "decisions made in one engineer's
session are visible to the reviewer", and it falls straight out of the source
binding.

### What gets pushed, and what does not

Push: `decided`, `constraint`, `blocked`, and anything explicitly bound to a
source the person is subscribed to.

Do not push: `produced`, `shipped`. These are feed material — real, worth
recording, worth searching, and not worth interrupting anyone over.

Plus a hard cap per person per session, oldest-highest-value first. When the cap
is hit, the rest is available on request and the delivery row records
`suppressed_reason`, so an over-tuned filter is visible in the data instead of
silently swallowing things.

### The new failure mode this introduces

Routing is the first thing in this system that moves a memory to somebody who did
not ask for it. **Every routing path must go through the same visibility
predicate as every read path.** `functions.sql` already names the shape of this
danger — the service-role path bypasses RLS entirely, so a missing `can_see()` in
one function leaks everything through that one tool while the table's RLS looks
perfectly correct. A router that skips the predicate is that bug with a delivery
mechanism attached. One predicate, called everywhere, no exceptions.

---

## 4. Permissions and sensitivity

Draft 1 had one axis: `private` / `team` / `company`. That conflates two
questions that need separate answers — *who is this for* and *how carefully must
it be handled* — and the security case is exactly where they come apart. A
security finding is for the team, and is also something that must never be
auto-routed, bulk-exported, or summarised into a digest.

**Axis one, `scope_type` + `scope_id` — the audience.** `person`, `team`,
`project`, `service`, `org`.

**Axis two, `sensitivity` — the handling.**

- `normal` — anyone in scope, routed normally.
- `confidential` — anyone in scope, but never auto-routed outside it, excluded
  from exports and digests, redacted in summaries. Reads still work; pushing does
  not.
- `restricted` — the explicit grant list in `memory_grants` and nobody else,
  regardless of scope. Security findings, anything about a named individual,
  anything under embargo.

**Axis three, classification at write time.** The write path proposes a
sensitivity rather than accepting the default, using the scanner already written
in `supabase/functions/hub/index.ts`. Its block/flag split carries over exactly:
a real credential in the body **blocks** the write; sensitive-looking content
**raises the sensitivity and says so** rather than refusing. A tool that refuses
legitimate content is a tool people route around, and the security skill that
legitimately contains an example key is the proof.

**Enforcement, one predicate.** RLS on the table covers PostgREST and the web
view. The service-role path — the MCP, the router, exports — bypasses RLS and
must call the same shared function. Not the same logic written out five times:
the same function. This is already the most dangerous property of the existing
`functions.sql` and the router makes it worse.

**Audit.** `memory_units` carries `promoted_by`/`promoted_at`;
`memory_deliveries` records who received what and when; `memory_feedback` records
who disputed or confirmed what. Together that answers "who contributed this and
when" and "who has seen it", which is the auditability the product promises.

---

## 5. Stack

Stay where the prior art already is, because it is measured rather than guessed:
Supabase Postgres at 7ms full-text search, RLS, and an Edge Function that is both
an MCP server and a plain JSON API, with the Cloudflare Worker in `gateway/`
doing OAuth so no database credential ever leaves Supabase.

Three deviations:

**Routing fan-out is an outbox drained by a worker**, not synchronous fan-out in
the write request. Recording must not fail because a delivery target is down.

**External adapters are separate small services**, one per system, each doing
webhook-in → `memory_subscriptions`/`memory_sources`-out. They hold the vendor
credentials; the core holds none. A Jira adapter breaking must not be able to
take the memory layer with it.

**The interface is HTTP with a stable JSON contract. MCP is one adapter over
it.** This is the concrete meaning of vendor-agnostic: Claude reaches the layer
through MCP because that is what Claude speaks, and an OpenAI or Gemini
integration later is a second adapter over the same HTTP surface, not a rebuild.

### The vendor-agnosticism rules, stated so they can be checked

1. No vendor name appears in a table name, column name, or enum value.
2. `origin_vendor` and `source_system` are text. Vendors and external systems are
   data.
3. Vendor-specific identifiers live only in `origin_ref` jsonb, and nothing in
   the core queries inside it.
4. Every capability reachable through MCP is reachable through the HTTP contract
   first. If a feature can only be expressed as an MCP tool, it is designed
   wrong.

---

## 5A. Collaboration between assistants — added to scope 20 August 2026

Draft 2 as written above lets one person's assistant *find* what another has
recorded. That is necessary and not sufficient. Two additions close the gap.

**Work claims.** An assistant declares what it is about to work on, and a
colleague's assistant checks before starting the same thing. This is the
cheapest anti-siloing mechanic available and the most directly felt: it stops
two people solving the same problem in parallel without either knowing.

Claims expire on a short timer, and that is the load-bearing decision rather
than a detail. A claim that outlives the session that created it is worse than
no claim at all, because it reports the work as covered when it was actually
abandoned partway through. Eight hours is the starting guess and should be
checked against real use.

**Collective project state.** One call, `get_project_state(scope)`, returning
the goal and current focus, recent decisions, live constraints, open blockers
and who they wait on, who is currently claiming what, and what shipped lately.

It is computed from the records on every call and stores nothing beyond
`scope_notes`, which holds only the small part that genuinely cannot be derived.
The moment it caches, it becomes a hand-maintained status document with extra
steps, and a stale status document is worse than none because people go on
trusting it.

**What is deliberately not built: a direct channel between assistants.**

This sounds like the obvious way to build collaboration and is the wrong shape.
Every record carries a `confidence` value precisely because assistants are
sometimes wrong. Pass one assistant's `inferred` guess straight into another as
an input, and two hops later it is being treated as established fact, with no
visible origin and no record that it happened. That destroys the provenance and
the audit trail, which are two of the things being sold.

Assistants share through the record instead. The claim stays attached to who
made it, how confident they were, and when. It is auditable by construction.

## 6. Explicitly not being built now

Named so they do not creep in: cross-department scoping beyond engineering,
non-Claude vendor adapters, and cross-employee project orchestration. The schema
is shaped so these are additions rather than rewrites (`scope_type` extends,
`origin_vendor` and `source_system` are already text), and that is the whole
obligation for this phase.

"A notion of a goal sitting above the record" was on this list and has moved
into scope as section 5A. `SCHEMA.md` deferred it on the grounds that it should
be added when a real deployment demanded it rather than guessed at early. That
condition is now met.

---

## 7. Open questions worth settling before code

**Subject versus source — do we still need both?** `subject` was the join key
when there was nothing external to join on. Now that memories bind to tickets and
PRs, the ticket is a better thread identity than a slug an agent guessed, and
subject sprawl was already flagged as the failure that makes the system
unqueryable while looking fine. My inclination: keep `subject` for work with no
external object, derive it from the source when there is one, and watch whether
it earns its place. **This is the one open question I would most like a decision
on before writing the DDL.**

**Does `org_id` go in now?** Deployments are isolated per company, so within one
instance it is redundant. It is cheap insurance and impossible to retrofit. My
inclination is yes, *with* a real RLS predicate on it — an unenforced tenant
column is worse than none, because it looks like isolation and is not.

**Where does delivery actually surface?** The ledger says a memory was delivered;
it does not say the engineer read it. Injecting into a session start is the
obvious answer and also the one most likely to be experienced as noise. Worth
prototyping against a real session before committing.

**Who can promote someone else's memory to a wider scope?** `promoted_by` exists
as a column; the rule for who may set it does not.

---

## Proposed schema

`proposed-schema.sql`, in this folder. Annotated DDL, not applied anywhere,
written to be argued with. It is a proposal against the local draft 1 — it needs
reconciling with whatever is already in `claude-comms` and the ddutche Supabase
before a single statement runs.
