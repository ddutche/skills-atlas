# Shared team memory layer: phased build plan

Written 20 August 2026. Hand this to a fresh chat. It assumes no memory of the
session that produced it.

Style note: this document avoids em dashes and heavy jargon on purpose, per the
`human-readable-changes` skill. The older design files in `workspace/` were
written before that rule was adopted and use a different style. Follow the rule
going forward, do not rewrite the old files for it.

---

## 1. The goal

A vendor-agnostic organizational knowledge and coordination layer, sold to
individual companies as isolated deployments (each company gets its own private
instance, its own users, its own data, nothing shared between companies).

The problem it solves is an anti-silo problem. When a company adopts AI
assistants, individual people get more productive but organizational knowledge
gets more fragmented, because each person's AI context is locked to them alone.
This product exists so that adopting AI consolidates what a company knows
instead of scattering it.

**First target, and the only one in scope right now:** shared team memory for
engineering teams using Claude Code. Today each engineer's context is trapped in
their own session. Ticket context does not follow a reassignment. Decisions made
in one engineer's session are invisible to the person reviewing their code.
Investigation context is lost when an incident changes hands.

**The seven things no AI vendor currently provides, which is the actual gap:**

1. A shared memory layer scoped to a team, project, or service, not a person.
2. A one-action way to promote something learned in a session to shared memory.
3. Automatic routing of context to the right person (ticket context follows the
   assignee, author context reaches the reviewer).
4. Permission and sensitivity scoping, so things like security findings can be
   restricted.
5. An audit trail of who contributed what and when.
6. **Collective project state.** A live "where things are at" for a project that
   any team member's assistant can read and contribute to, so one person's
   assistant knows what another person's assistant has already done.
7. **Work claims.** A cheap way for one person's assistant to say "I am on this
   right now" so a colleague's assistant does not silently duplicate the work.

**The Claude Skills Atlas is part of this product, not a separate one.** It is
the shared catalogue of reusable instructions people have written. It already
shares the `people` table with the memory layer and already shares one MCP
connection (see `workspace/tools.ts`, which merges both domains into nine
tools). It is the adoption wedge: it installs quickly and is immediately useful,
which is what gets the connection in place that the memory layer then needs. See
Phase 2A.

**Explicitly out of scope for now,** named so it does not creep in:
cross-department scoping, non-Claude vendor adapters, and cross-employee project
orchestration. The data model is shaped so these are later additions rather than
rewrites. That is the whole obligation for this stage.

Note that "a concept of a goal sitting above the record" was previously on this
out-of-scope list and has now been **moved into scope**, as items 6 and 7.
`workspace/SCHEMA.md` deferred it deliberately, saying it should be added when a
real deployment demanded it rather than guessed at early. That condition is now
met.

---

## 2. Where things actually stand, verified 20 August 2026

### Live database

Supabase project `overmssglaikxnwtfvoc`, named "ddutche's Project",
ca-central-1, Postgres 17. This is on the personal ddutche account. There is
exactly one project on that account, so there is no risk of touching anything
belonging to the former employer through it.

Nine migrations applied, latest `20260812013917_oauth_gateway_state`. Live
contents:

- Seven tables, row-level security enabled on all of them, and **zero rows in
  every single one**.
- Tables: `people`, `skills`, `skill_installs`, `settings`, `work_records`,
  `oauth_clients`, `oauth_codes`.
- Four enum types: `work_kind`, `work_status`, `work_confidence`,
  `work_visibility`.
- One view: `current_work`.
- Seven work functions: `can_see`, `catch_up`, `find_work`, `record_work`,
  `whats_blocked`, `who_worked_on`, `work_records_derive`.
- Plus a skills layer (`search_skills`, `get_skill`, `publish_skill`,
  `record_install`, `get_atlas`) and an OAuth layer (`oauth_*`), neither of
  which the memory work should touch.

The zero-row state matters more than anything else here. It means the schema can
still be restructured freely. That window closes permanently the first time real
data is written.

### Repositories

- `ddutche/claudecomms` is the intended home. It is private and empty, and
  nothing has been pushed to it.
- `ddutche/skills-atlas` is private, and is the git remote for the local
  `intel-hub` repo.
- `ddutche/skill-atlas` (singular) is public and is the older React canvas tool,
  unrelated to the memory work.

**Nothing about the memory layer is committed anywhere.** The whole engineering
record lives untracked in one working tree on one machine. Fixing that is the
first action below.

### Access notes for the next session

The active GitHub CLI account is `Ddottimate`, pinned by a `GITHUB_TOKEN`
environment variable that overrides the keyring. That account cannot see private
ddutche repos. To work with `ddutche/claudecomms` the environment variable has
to be unset first, then `gh auth switch --user ddutche`.

The Supabase MCP connector is already authorized to the ddutche account and
needs no change.

**Hard rule from the user, carried forward: do not touch anything on any
Ddottimate repo or Ddottimate Supabase.**

---

## 3. Decisions already made, with the reasoning

Preserve these. Re-deciding them wastes a session, and the reasoning is the part
that is expensive to reconstruct.

**One table, not two.** A personal tier and a shared tier as separate tables
would mean two write paths and a permanent question about which one a thing
belongs in. `scope_type = 'person'` is the personal tier, and promotion is a
scope change on the same row.

**`work_records` becomes `memory_units`, by drop and recreate.** The table is
empty, and the enum changes make an in-place alter several times longer than a
clean create for identical output. "Work record" is also the wrong name for a
vendor-agnostic memory layer, and this is the last moment the rename is free.

**`subject` survives, but is derived from the bound source when one exists.**
Work with no ticket still needs a thread, so the field stays. But a slug an
agent guessed is a worse thread identity than a ticket id, and subject sprawl is
the failure that makes the whole system unqueryable while everything still looks
fine.

**Audience and sensitivity are two separate columns**, replacing the single
`visibility` field. A security finding is *for the team* and also must never be
auto-routed, bulk-exported, or summarized into a digest. One column cannot say
both. This split cannot be retrofitted, which is why it was made now.

**One new kind, `constraint`.** A durable rule that limits future work, for
example "this endpoint rate-limits at 10 per second". It is separate from
`learned` because the two travel differently: a constraint is pushed at whoever
is about to touch the thing, a learning is pulled when someone searches. If they
share a kind, routing cannot tell them apart and either pushes too much or
nothing at all.

**`origin_vendor` and `source_system` are plain text, never enums.** Vendors and
external systems are data, not vocabulary. An enum there is exactly the
hard-coding that makes a rewrite necessary later. Vendor-specific identifiers
live only in the `origin_ref` JSON column, and nothing in the core queries
inside it.

**`org_id` is real, not decorative.** There is an `orgs` table, real foreign
keys, and a row-level security check on it. A tenant column that nothing
enforces is worse than no tenant column, because it looks like isolation and is
not.

**Promotion authority: you may promote into a scope you belong to, and not into
one you do not.** Enforced in the insert policy rather than left to convention.

**Assistants share through the shared record, never by messaging each other
directly.** This one is worth defending, because "let the assistants talk to
each other" sounds like the obvious way to build collaboration and is the wrong
shape.

Every memory carries a `confidence` value (`stated`, `observed`, `inferred`)
precisely because assistants are sometimes wrong. If one assistant's `inferred`
guess is passed straight to another assistant as an input, two hops later it is
being treated as fact, nobody can see where it came from, and there is no record
of it having happened. That destroys both the provenance and the audit trail,
which are two of the things being sold.

Sharing through the record keeps all of it intact: the claim stays attached to
who made it, how confident they were, and when. It is auditable by construction.
The same reasoning is already written into `intel-hub/CLAUDE.md` as
"hub-and-spoke, not mesh".

**Project state is derived, not maintained.** A hand-maintained status document
rots, quietly, and a rotted one is worse than none because people still trust
it. So `get_project_state` computes the picture from the records every time it
is asked. Only the small part that genuinely cannot be derived (the goal, the
current focus) is stored, in `scope_notes`.

---

## 4. Inherited gotchas, each of which cost real time

`workspace/STATE.md` has the full list and is worth reading once. These are the
ones that bear directly on the next phases:

**Supabase grants EXECUTE on new functions to `anon` and `authenticated` by
name,** through default privileges, on top of the standard Postgres grant to
PUBLIC. So revoking from PUBLIC alone is correct on stock Postgres and
insufficient here. This exact gap left two write functions reachable by anonymous
callers, and the database linter did not catch it. Only reading `proacl`
directly did.

**The counter-trap:** a row-level security policy is evaluated as the calling
role, so a policy that calls a helper function still needs that role to hold
EXECUTE on it. Revoking too aggressively does not tighten the policy, it breaks
every read for signed-in users, and it looks like a broken application rather
than a permissions mistake.

**A view runs as its owner by default** and reads straight past row-level
security. `security_invoker = true` is mandatory on every view over
`memory_units`. Draft 1 shipped this bug and it was found by running the schema,
not by reading it.

**A scanner that blocks legitimate content gets switched off.** The existing
credential scanner splits its rules deliberately: a real credential blocks a
write, everything else is flagged and allowed through. This exists because the
skill that teaches people to keep secrets out of code legitimately contains an
example private key header. A tool people route around protects nothing.

**There was no way to tell what was deployed** without exporting the live script
and diffing it. Three copies of the source had drifted and the newest was not the
one running. Whatever gets built needs one source of truth for what is live. This
directly shapes Phase 0.

**Reading SQL carefully catches about half of what executing it does.** Two of
draft 1's worst bugs were invisible in review and obvious on the first real
query. This is the reason every phase below has an execution gate rather than a
review gate.

---

## 5. The phased plan

Each phase has work, a verification approach, and a gate. **Do not start a phase
until the previous gate is genuinely met**, and report a gate as met only with
real output, never with an assurance that it should pass.

Time estimates are rough and assume one person working with an assistant. Treat
them as relative sizes rather than commitments.

---

### Phase 0: One source of truth (about half a day)

The whole design record currently exists untracked on one machine, and the last
version of this project was sunk partly by not knowing what was deployed. Fix
both before writing anything new.

**Work**
1. Unset `GITHUB_TOKEN`, switch the GitHub CLI to the ddutche account.
2. Push the `projects/skill-atlas/` tree to `ddutche/claudecomms`. Decide
   whether it becomes its own repository (recommended) or stays nested inside
   `intel-hub`. It should be its own, because `intel-hub`'s root `CLAUDE.md`
   describes a personal knowledge system and will mislead every future session
   that works on this product.
3. Write a `CLAUDE.md` for the product itself, and a `CHANGELOG.md`.
4. Adopt the Supabase CLI so `supabase/migrations/` is the only description of
   the database, and rename the Supabase project to `claudecomms`.

**Verification**
Run `supabase db diff` against the live project and get an empty result. That
empty diff is the proof that the repository and the live database agree, and it
is exactly the check whose absence cost this project real time before.

**Gate:** empty diff, and the work is pushed and visible on GitHub.

---

### Phase 1: The store (one to two days)

**Work**
1. Apply `workspace/memory-layer-migration.sql` as a properly timestamped
   migration. Do not rename the timestamp prefix, migration tooling depends on
   it.
2. Build a fixture set: three people across two teams, three scopes of different
   types, and memories covering every combination of scope type and sensitivity.
3. Build the row-level security test suite described below.

**Verification, and this is the part that matters**

*Test as real roles, never as the service role.* Both of draft 1's worst bugs
(the view that bypassed security, and the predicate that let an unrecognized
viewer read everything) were invisible in review and obvious the moment someone
queried as an actual user. Sign in as each fixture person and assert exactly
which memory ids come back.

*Write the negative tests first.* Assert that person A **cannot** see person B's
private memory, cannot see a restricted memory they hold no grant for, and
cannot see another team's team-scoped memory. A suite that only asserts
positives passes cleanly against a wide-open database. Make it table-driven, one
row per combination of viewer, memory, and expected result, so gaps in coverage
are visible as missing rows.

*Audit the grants as an automated test, not a one-time check.* Query
`pg_proc.proacl` and assert that no function in the schema is executable by
`anon`. This is the trap that has now bitten this project twice and that the
database linter missed both times.

**Gate:** the visibility matrix passes including every negative case, and the
grant audit is clean.

---

### Phase 2: The write path and promotion (three to five days)

This phase answers the question the entire product rests on: will anyone
actually use it?

**Work**
1. `record_memory` RPC, replacing `record_work`.
2. Source inference from local git context: branch name to ticket, remote to
   repository, `gh pr view` to pull request.
3. The MCP tool, and the `/share` slash command for Claude Code.
4. `flag_candidate`, the free no-confirmation path.

**Verification**

*Shadow the source inference before anything depends on it.* Run the inference
over the last fifty branches in a real repository and record what it **would**
have bound, writing nothing. Check the results by hand. Routing quality is
entirely downstream of source binding, so a quiet 30% error rate here would
surface much later as "routing does not work" with no obvious cause.

*Contract tests on the RPC.* Feed it a malformed subject, a blocked record with
no reason given, and an unknown person. Assert each returns a sentence a person
can act on, not a raw database constraint violation.

**Gate, and it is a behavioral one:** in a week of real use, does an engineer
promote something to shared memory **without being asked to**? That was the only
real evidence the previous version of this project ever worked, and it is the
right bar. If `/share` goes unused, the friction is too high, and no amount of
downstream work fixes it. Reduce friction and repeat rather than moving on.

---

### Phase 2A: The Skills Atlas, revived as the adoption wedge (about a week, runs parallel to Phase 2)

Run this alongside Phase 2, not after it. Phase 2's gate asks whether an
engineer promotes something without being prompted, and that cannot be measured
unless people already have the MCP connection installed and are using it for
something. The skills catalogue is what gets it installed. It is immediately
useful on its own, and it is the reason someone connects in the first place.

**The finding that makes this cheap.** `STATE.md` lists five known-broken items.
Four of them are problems with the Google Apps Script path specifically, and
they simply disappear if that path is dropped in favour of the Supabase plus
OAuth gateway path that is already written:

- The single shared `HUB_TOKEN` and the self-asserted `X-Hub-User` header are
  replaced by real per-user OAuth. The gateway already exists at
  `gateway/src/index.ts`.
- Identity keyed on an email field inside a `profile.json` file is replaced by
  the real `people` table.
- The missing scan on the Apps Script publish path stops existing along with the
  path.
- The missing `LockService` on profile writes likewise.

Only one survives the move: **`sanitizeSvg` is a blocklist and its output is
injected raw**, which is a stored cross-site scripting hole in the atlas front
end. That is real and has to be fixed properly, with an allowlist based
sanitizer rather than another blocklist.

**Work**
1. Deploy the Edge Function. `STATE.md` records that it was written and
   scanner-tested but **never deployed**, which means the MCP server has never
   actually existed and nothing has ever scanned a publish.
2. Fix the `sanitizeSvg` hole properly.
3. Retire the Apps Script path, or keep it clearly marked as a demo that is not
   for company use.
4. Wire the four skills tools and the memory tools into one MCP surface, which
   `workspace/tools.ts` already specifies.

**Verification**
The scanner test at `supabase/test/scan.test.mjs` already exists and passes (5
credential types refused, 6 documentation examples allowed). Keep that split
intact: a real credential blocks a publish, everything else is flagged and
allowed. A scanner that refuses the security skill's own example key is a
scanner people switch off.

For the XSS fix, write an actual test with hostile SVG input. This one is worth
testing rather than reviewing, because a blocklist always looks correct right up
until someone finds the entry it is missing.

**Gate:** the Edge Function is deployed and reachable, the MCP connection serves
both skills and memory tools, the scanner test passes, and hostile SVG input is
provably neutralised.

---

### Phase 3: The read path (two to three days)

**Work**
Rewrite `find_work`, `catch_up`, `who_worked_on` and `whats_blocked` against
`can_see_memory`, and build the session-start briefing.

**Verification**

*Write every question out as a raw query before writing the function.* Draft 1
found three real schema bugs this way, including a missing index on the single
most frequently run query in the system. The questions are listed in
`workspace/queries.sql`. If any one of them is awkward to express, the schema is
wrong and should change, rather than the query getting cleverer.

*Measure `can_see_memory` under load.* It is a function call with subqueries
evaluated per row, where draft 1 had deliberately learned to compare a plain
column instead. That was a conscious trade of speed for correctness and it is
completely unproven. Run `EXPLAIN ANALYZE` at ten thousand and one hundred
thousand rows. If it does not hold up, the fix is a materialized membership
column, never a second copy of the predicate logic.

*Assert mechanically that every read path calls the predicate.* A test that
enumerates the functions in the schema and checks each read function references
`can_see_memory`. A missing call leaks everything through that one function
while the tables' security still looks perfectly correct, which makes it exactly
the class of bug that survives code review.

**Gate:** all six questions answerable, performance measured and recorded (not
estimated), and the predicate-coverage test passing.

---

### Phase 3A: Collective project state and work claims (three to four days)

This is the phase that makes one person's assistant genuinely aware of what
another person's assistant has done. It depends on Phase 3 because everything
here has to be filtered through the same visibility predicate.

**Work**

1. **`work_claims`.** An assistant declares "I am about to work on PROJ-123" at
   the start of a session, and a colleague's assistant checks before starting
   the same thing. Three tools: `claim_work`, `check_claims`, `release_work`.

   Claims expire automatically on a short timer, and that is the important
   design point. A claim that outlives the session that made it is worse than no
   claim at all, because it tells the next person the work is covered when it
   was actually abandoned halfway through. Default to something like eight
   hours, and release explicitly at session end.

2. **`scope_notes`.** The small curated part of project state: the goal, and the
   current focus. This is the only part stored rather than computed, because it
   is the only part that cannot be derived from what people have recorded.

3. **`get_project_state(scope)`.** One call that assembles the whole picture:
   goal and current focus, recent decisions, active constraints, open blockers
   and who they wait on, who is currently claiming what, and what shipped
   lately. Computed from the records on every call, never stored.

**Verification**

*Prove the state is genuinely derived, by mutation.* Write a record, call
`get_project_state`, and assert the new record is reflected without any separate
update step. Then supersede that record and assert it disappears from the state.
A "derived" view that quietly caches is just a hand-maintained document with
extra steps, and this test is what tells the two apart.

*Test claim expiry as a first-class case, not an edge case.* Create a claim,
move the clock past its expiry, and assert `check_claims` no longer reports it.
The whole value of claims rests on stale ones disappearing on their own, so this
is the load-bearing test.

*Visibility applies to claims too.* A claim names a ticket and a person, and who
is working on what can itself be sensitive. Assert that claims are filtered
through the same predicate as everything else, rather than being treated as
harmless metadata.

*Two-session test, run by hand.* Open two sessions as two different fixture
people. Have the first claim a subject. Assert the second is told about it
before it starts work. This is the actual product promise in miniature, and it
is worth watching happen rather than inferring from passing tests.

**Gate:** the derived-state mutation test passes, claims provably expire on
their own, and the two-session test visibly prevents a duplicate effort.

---

### Phase 4: Routing (about a week)

The highest-value phase and the highest-risk one, because it is the first thing
that sends someone information they did not ask for.

**Work**
1. The GitHub adapter first: pull request review requested, and issue assignment.
   Highest signal and simplest authentication.
2. Subscription backfill, which is the direction that delivers the actual
   product promise: when a ticket is reassigned, the new assignee receives
   everything already bound to it.
3. The outbox worker, and per-session delivery caps.

**Verification, and shadow mode is mandatory here rather than optional**

*Run the router in shadow for a full week before it delivers anything.* Compute
every delivery and write it to the ledger with `suppressed_reason = 'shadow'`,
then send nothing. The schema already supports this through the existing
`suppressed_reason` column. After a week, read what it **would** have sent.

This is the cheapest possible way to discover that routing is noise, before a
single person is annoyed by it. The failure mode to fear is not routing too
little, it is routing so much that people mute it, and a muted channel protects
nothing. Leave shadow mode only after a human has read a week of shadow
deliveries and judged what fraction was genuinely worth interrupting someone
for. If that fraction is low, tighten the rules and shadow again. Do not ship
routing on optimism.

*Replay real webhook payloads as fixtures.* Capture actual GitHub payloads,
replay them, and assert the resulting subscription set. Webhook shapes drift,
and hand-written fixtures drift with them silently.

*The leak test, run on every build.* Assert that the router never delivers a
memory the recipient could not have read directly by querying. This is the one
genuinely new failure mode routing introduces, and it deserves a dedicated
permanent test rather than a careful review.

*Idempotency test.* Replay the same webhook three times and assert exactly one
delivery row exists.

**Gate:** shadow week reviewed by a human and judged useful, leak test passing,
idempotency proven by replay.

---

### Phase 5: Sensitivity and audit (about a week)

This is the phase that makes the product survive a buyer's security review.

**Work**
1. The sensitivity classifier on the write path, reusing the existing scanner.
2. Restricted sensitivity and the explicit grant list.
3. Audit views.

**Verification**

*Shadow the classifier exactly like the router.* Run it over every memory
written during Phases 2 through 4, record what it **would** have escalated, and
enforce nothing. Then compare against human judgment to get a real false
positive rate before it can cost anyone anything.

This matters because of the scanner lesson: a classifier that blocks legitimate
content gets switched off, and a tool people route around protects nothing.
Shadow mode is how you learn the false positive rate without paying for it.

*Reuse the existing scanner test harness pattern.* See
`supabase/test/scan.test.mjs`. It assembles fake credentials from pieces at
runtime, because a pre-write secret hook cannot distinguish an invented
credential from a real one and therefore refuses to let a test file full of fake
ones exist on disk at all.

*Audit completeness test.* For any given memory, assert the trail can answer:
who wrote it, who promoted it, who received it, and who disputed it. Those four
questions are the audit trail the product promises, so they should be a test
rather than a claim.

**Gate:** classifier false positive rate measured and acceptable, and all four
audit questions answerable from the schema.

---

### Phase 6: Deployment and isolation (about a week)

**Work**
One-command deployment of an isolated instance, and a documented path from zero
to a working install for a new company.

**Verification**

*Two-instance isolation test.* Stand up two separate instances, write data to
both, and assert zero cross-visibility. The `org_id` predicate has never been
tested against a genuine second tenant, and isolation is the first thing a
buying company's security review will ask about. An untested isolation claim is
not a claim worth making.

*Deploy provenance.* Every deployment stamps a version that can be read back out
of the running system, so "what is live" is answerable directly rather than by
exporting and diffing. This addresses head-on the failure that cost the previous
version of this project real time.

**Gate:** two instances proven isolated, and the running system can report its
own version.

---

### Phase 7: Commercial readiness (starts during Phase 4, continues throughout)

Instrument from Phase 4 onward, because these numbers are both what a buyer asks
for and what tells you honestly whether the thing works:

- Promotions per engineer per week (are people contributing?)
- Share of deliveries acknowledged (is routing useful or noise?)
- Memories disputed or marked stale (is the content trustworthy?)
- Time for a newly assigned engineer to reach useful context (the headline
  number, and the one worth building a sales case on)

The commercial argument is not "AI memory". It is that a reassigned ticket, a
handed-over incident, and a code review each currently lose context that a
company already paid to produce, and this measurably stops that. The audit trail
and the isolation model are what let a security team approve it. Both are why
Phases 5 and 6 are not optional polish.

---

## 6. Working practices, applied in every phase

From the `human-readable-changes` skill:

- **Migrations:** never rename the auto-generated timestamp prefix, tooling
  depends on it. Put a short title on the first line, then a header comment
  saying what it does and *why it was needed* (the real reason, not a
  restatement of the SQL). Comment anything a reader would otherwise have to
  reverse-engineer, especially constraints, indexes and security policies.
- **Comments generally:** a plain-language "what" on functions and non-trivial
  blocks, plus a "why" wherever there is a decision or workaround the code
  cannot explain on its own. The bar is not "would a senior engineer need this",
  it is "can someone who is not coding full time follow along".
- **Every meaningful change gets a `CHANGELOG.md` entry**, dated, a sentence or
  two, describing the effect rather than the implementation.
- **`CLAUDE.md` stays narrow and stable.** Update it only for a durable
  convention, a new command, or an architecture change. It is not a running log.
- **Style:** no em dashes. Avoid jargon, and briefly explain any technical term
  that is genuinely unavoidable.
- **Save a project memory after landing each phase**, in the memory directory
  named below.

From `verify-before-shipping`: never report a phase complete without showing
real output. Add a regression test for every bug fixed, so the same bug cannot
come back quietly.

---

## 7. What to read, in order

**Read these first (all five, they are the whole design):**

1. `C:\Users\donov\intel-hub\projects\skill-atlas\workspace\shared-memory-plan.md`
   The design and its reasoning. Start here.
2. `C:\Users\donov\intel-hub\projects\skill-atlas\workspace\memory-layer-migration.sql`
   The migration to apply in Phase 1, written against the verified live state.
3. `C:\Users\donov\intel-hub\projects\skill-atlas\STATE.md`
   Every gotcha, each of which cost real time to find.
4. `C:\Users\donov\intel-hub\projects\skill-atlas\workspace\SCHEMA.md`
   Draft 1's reasoning, most of which still holds.
5. `C:\Users\donov\.claude\projects\C--Users-donov-intel-hub\memory\skills-hub-scanner-and-lucid.md`
   Project memory with history and account details.

**Read if you touch that area:**

- `workspace/queries.sql` before Phase 3. The six questions, and the three
  schema bugs that writing them exposed.
- `workspace/functions.sql` before Phases 2 and 3. The five draft-1 RPCs being
  replaced, and the reasoning behind their arguments.
- `workspace/tools.ts` before Phase 2. The MCP tool surface and, more usefully,
  why the tool descriptions are worded the way they are.
- `supabase/functions/hub/index.ts` and `supabase/test/scan.test.mjs` before
  Phase 5. The scanner worth reusing.
- `gateway/src/index.ts` and `gateway/DEPLOY.md` before Phase 6. The OAuth
  gateway, already written.
- `workspace/proposed-schema.sql` only for history. It was superseded by
  `memory-layer-migration.sql`, which was written after the live database could
  actually be read.

**Do not treat `intel-hub/CLAUDE.md` as guidance for this product.** It
describes a separate personal knowledge system that happens to contain this
folder.

---

## 8. Next actions, in order

1. **Commit and push the design work to `ddutche/claudecomms`.** Everything
   listed above exists only in one untracked working tree on one machine. This
   is Phase 0 step 1 and it should happen before anything else.
2. Decide whether `claudecomms` becomes its own repository (recommended) or
   stays nested inside `intel-hub`.
3. Adopt the Supabase CLI and get an empty `supabase db diff` against
   `overmssglaikxnwtfvoc`.
4. Apply `memory-layer-migration.sql` and build the visibility test suite.
5. Begin Phase 2.

---

## 9. Open questions for the user

- Should `claudecomms` be its own repository, separate from `intel-hub`?
  Recommended, but it is the user's call.
- Which real repository should Phase 2's source inference be shadowed against?
  It needs one with a genuine history of ticket-named branches.
- Is there a real engineering team available for the Phase 2 behavioral gate, or
  does that gate have to be met by the user alone? This materially changes how
  much the result can be trusted.
- Phase 4 needs GitHub webhooks pointed at a reachable endpoint. Where should
  that run?
- Should the Google Apps Script path be retired outright in Phase 2A, or kept as
  a marked demo? Retiring it removes four of the five known-broken items for
  free, but it also removes the thirty-minute install that needs no security
  review, which was the original reason anyone tried it. The recommendation is
  to retire it for company deployments and keep it only as a demo, but it is a
  product decision rather than a technical one.
- Eight hours is a guess at the right lifetime for a work claim. It should be
  checked against how people actually work before it hardens.

---

## 10. Dead ends, recorded so they are not revisited

- **Lucid as the front end.** Its REST API cannot edit an existing document.
  Document Contents is create-only, and Update Document changes only the title
  and parent folder. The in-place edits that did work went through a different
  surface that needs a human session, so unattended sync is impossible. See
  `lucid/lucid-sync/README.md`.
- **Google Apps Script and Drive as the backend at scale.** It works and
  installs quickly, but a cold rebuild at a thousand skills takes 210 to 421
  seconds and Apps Script kills execution at six minutes.
- **`proposed-schema.sql`.** Written before the live database could be read, and
  superseded. Kept only as history.
