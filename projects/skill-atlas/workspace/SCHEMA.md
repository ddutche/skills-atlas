# The work record — draft 1, 11 August 2026

The thing a person's Claude writes when it does something, so that a colleague's
Claude can find out what happened and work out what to do next.

This is the whole system. Everything else — the database, the MCP, the web view
— is machinery for storing and serving these. Getting the record right early is
worth more than any amount of infrastructure, because every query anyone ever
writes inherits its shape.

Written to be read by whoever is going to use it, not only by whoever builds it.

---

## Two rules the design is bent around

**1. Structured, not prose.** If Claude writes "worked on the Acme integration
today", the next agent has to read it and guess. If it writes a typed record
with a subject, an artifact and a status, the next agent can query it. That
difference is the entire gap between a shared folder and a system that can
answer "what should I pick up".

**2. Writing a record has to be nearly free.** If recording is a separate step
someone has to remember, they won't, and the workspace is empty inside two
weeks. It has to fall out of work already happening — which is why the write
path is an MCP tool the agent calls as a side effect of doing the thing, not a
form anybody fills in.

Everything below serves those two. Where they conflict, the second wins, because
a perfect schema nobody writes to is worth nothing.

---

## The record

| field | what it is |
|---|---|
| `id` | unique, generated |
| `occurred_at` | when the work happened |
| `recorded_at` | when it was written down. Different from the above when catching up. |
| `person_id` | whose work it is. Always a person, never an agent. |
| `agent` | which assistant wrote it, or empty if a human did |
| `kind` | one of six, below |
| `summary` | one plain sentence, under 300 characters |
| `detail` | optional, longer |
| `subject` | the thread this belongs to — the join key, see below |
| `artifacts` | what it produced: links, file paths, doc ids |
| `status` | `open`, `done`, `blocked`, `abandoned` |
| `blocked_on` | plain text: what is in the way |
| `needs_from` | a person who can unblock it |
| `supersedes` | the record this replaces, if any |
| `confidence` | `stated`, `observed`, `inferred` |
| `visibility` | `private`, `team`, `company` |
| `tags` | free labels |

## The six kinds

A closed set, deliberately. An open one cannot be queried — you end up with
forty spellings of the same thing and no way to ask a general question. Six is
small enough that a person can hold it in their head, and it was chosen so that
an account executive and a backend engineer can both map a normal day onto it
without translating.

- **`produced`** — a thing now exists. A deck, a draft, a pull request, an
  analysis, a spreadsheet.
- **`shipped`** — something went out into the world. Sent, deployed, published,
  presented. Distinct from `produced` because "it exists" and "it is out there"
  are different states and only one of them ends a thread.
- **`decided`** — a choice was made, with the reason. The most valuable kind and
  the one people record least, because deciding does not feel like output.
- **`learned`** — found something out that someone else would want to know.
- **`blocked`** — hit something they cannot get past.
- **`asked`** — waiting on a specific person.

No `started`. Starting is not interesting, and recording it would roughly double
write volume for almost no query value.

## `subject` — the join key, and the hard part

Two records are about the same thing when they share a `subject`. This is what
turns a pile of events into a thread, and it is the field most likely to go
wrong, because agents choosing free text will produce `acme-integration`,
`acme_integration` and `Acme integration` within a week.

The draft answer: `subject` is a slug, and the MCP's write tool returns the
closest existing subjects so the agent reuses one rather than minting a variant.
Cheap, and it degrades gracefully — a wrong subject splits a thread but loses
nothing.

**This is the field to watch in the first real deployment.** If subjects sprawl,
the workspace becomes unqueryable and everything else still looks fine.

## `confidence` — why it is not optional

Agents write most of these, and agents are sometimes wrong. A record that says
"the customer wants SSO" reads identically whether the customer said it, the
agent saw it in a ticket, or the agent guessed from context. Those are very
different facts and the third one should not get someone's quarter reorganised.

- **`stated`** — a person said it, directly
- **`observed`** — the agent saw it in a file, ticket, message or tool result
- **`inferred`** — the agent concluded it

Carried over from the atomic record in `intel-hub/CLAUDE.md`, where the same
distinction was already load-bearing. It is also the most obvious differentiator
available: shared agent memory is being shipped elsewhere without any account of
what happens when a memory is wrong.

## `visibility` — decide this before writing any code

- **`private`** — only the person
- **`team`** — their team
- **`company`** — everyone

**Default: `team`.** This is a real trade-off and it should be a decision rather
than a default nobody examined. `private` by default is safer and produces an
empty, useless workspace. `company` by default is most useful and will
eventually publish something about compensation, a customer's data, or a person.
`team` is the compromise, and it is only defensible if the write tool actively
chooses `private` when content looks sensitive rather than relying on the
default.

Retrofitting this is impossible, which is why it is in draft 1 and not draft 3.

## `supersedes` — how a record stops being true

Without this, the workspace fills with contradictions and quietly stops being
trustworthy: a `blocked` from Tuesday sits next to the `shipped` from Thursday
with nothing saying which is current.

A record points at the one it replaces. "Current" is then everything nothing
else supersedes — a view, not a status anyone maintains. Nothing is ever
deleted, so the history stays intact and "what did we think in August" is still
answerable.

---

## The queries this has to answer

The test of the schema. If one of these is awkward, the schema is wrong:

- What has this person done in the last week?
- What is happening on this subject, in order?
- What is blocked right now, and who is it waiting on?
- What did we decide about X, and why?
- Who has touched anything like this before?
- What changed since I last looked?

## What is still open in this draft

**Threads across people.** If two people work the same subject independently,
this joins them — which is the point, and also means a subject can become a
firehose. May need a parent/child relationship.

**Artifacts are just links.** Nothing checks they resolve, and nothing notices
when a doc is deleted. Fine for draft 1; a dead-link problem later.

**No notion of a goal.** Records say what happened, not what anyone is trying to
achieve. "Decide what's next" may need something above this. Deliberately left
out — it is the kind of structure that should be added when a real deployment
demands it, not guessed at now.

**No verification.** Nothing marks a record as later found wrong. `supersedes`
handles replacement but not "this was mistaken."
