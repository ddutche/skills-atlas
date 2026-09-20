-- The memory layer — migration, draft 2. 20 August 2026.
--
-- *** NOT APPLIED. NOT RUN. FOR REVIEW. ***
--
-- Supersedes proposed-schema.sql in this folder, which was written before the
-- live database could be read. This one is written against the actual state of
-- project overmssglaikxnwtfvoc, verified 20 August 2026:
--
--   9 migrations applied, latest 20260812013917_oauth_gateway_state
--   7 tables, RLS on all of them, ZERO ROWS IN EVERY ONE
--   4 enum types: work_kind, work_status, work_confidence, work_visibility
--   1 view: current_work
--   7 work functions: can_see, catch_up, find_work, record_work,
--     whats_blocked, who_worked_on, work_records_derive
--
-- The skills layer (get_atlas, get_skill, publish_skill, record_install,
-- search_skills) and the OAuth layer (oauth_*) are NOT touched by this file.
--
-- When approved, this moves to supabase/migrations/ with a timestamp prefix.
--
-- ---------------------------------------------------------------------------
-- Decisions taken here, made rather than asked. Each is reversible today and
-- expensive to reverse once anything is written.
--
-- 1. work_records becomes memory_units, by drop and recreate rather than
--    rename-and-alter. The table is empty, and the enum changes (a new kind,
--    visibility splitting in two) make an in-place ALTER path several times
--    longer than a clean create for identical output.
--
-- 2. `subject` survives, and the write path derives it from the bound source
--    when there is one. Kept because work with no ticket still needs a thread;
--    derived because a slug an agent guessed is a worse thread identity than a
--    ticket id, and subject sprawl is the failure that makes the system
--    unqueryable while everything still looks fine.
--
-- 3. `constraint` stays as an enum label. My earlier note called it a papercut
--    for being a reserved word; that was over-cautious. Enum labels are string
--    literals, never identifiers, so 'constraint' is safe in every position it
--    is actually used.
--
-- 4. org_id is real, not decorative: an orgs table, foreign keys, and an RLS
--    predicate that checks it. A tenant column nothing enforces is worse than
--    no tenant column, because it looks like isolation and is not.
--
-- 5. Promotion authority: you may promote into a scope you belong to, and not
--    into one you do not. Enforced in the insert policy, not by convention.
-- ---------------------------------------------------------------------------

begin;

-- ===========================================================================
-- 0. Refuse to run if the assumption this migration rests on is false
--
-- Everything below drops work_records outright. That is correct while the
-- table is empty and catastrophic once it is not. Checked rather than trusted,
-- because "it was empty when I looked" and "it is empty now" are different
-- statements and only one of them is safe to drop a table on.
-- ===========================================================================
do $$
declare n bigint;
begin
  select count(*) into n from public.work_records;
  if n > 0 then
    raise exception
      'work_records has % row(s). This migration drops it and is only safe on an empty table. Migrate the data first.', n;
  end if;
end $$;


-- ===========================================================================
-- 1. Remove the draft-1 work layer
--
-- Ordered: view, then functions, then table, then types. Types last because
-- the functions and the table both reference them, and dropping a type with
-- CASCADE to get around that would take the skills layer's grants with it.
-- ===========================================================================
drop view if exists public.current_work;

drop function if exists public.can_see(work_visibility, text, text, text);
drop function if exists public.catch_up(text, text, text, integer);
drop function if exists public.find_work(text, text, text, text, text, work_kind, work_status, text, integer);
drop function if exists public.record_work(text, work_kind, text, text, work_confidence, text, jsonb, work_status, text, text, uuid, work_visibility, timestamptz, text[], text);
drop function if exists public.whats_blocked(text, text, text, integer);
drop function if exists public.who_worked_on(text, text, integer);
drop function if exists public.work_records_derive();

drop table if exists public.work_records;

drop type if exists public.work_kind;
drop type if exists public.work_status;
drop type if exists public.work_confidence;
drop type if exists public.work_visibility;

-- Kept deliberately: parse_since (generic, reused below), current_person_id
-- and my_team (still needed by RLS on the skills tables).


-- ===========================================================================
-- 2. Tenancy
--
-- Deployments are isolated per company, so in practice this table has one row.
-- It exists so the isolation is a foreign key rather than an assumption, and
-- because it cannot be retrofitted once rows exist.
-- ===========================================================================
create table public.orgs (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

insert into public.orgs (id, name) values ('default', 'Default organisation');

alter table public.people
  add column if not exists org_id text not null default 'default'
    references public.orgs (id) on delete restrict;


-- ===========================================================================
-- 3. person_identities — the missing prerequisite
--
-- Routing cannot work without this. A GitHub webhook says "assigned to
-- account 12345"; a Jira webhook says "assigned to accountId abc-def". Neither
-- is an email, and there is otherwise no path from an external event to a
-- person_id. This was the largest gap in the previous draft.
--
-- Keyed on (system, external_id) rather than (person_id, system): the frequent
-- lookup is external -> person, and this direction also enforces that one
-- external identity resolves to at most one person, which the other direction
-- does not.
--
-- external_id is the system's STABLE identifier, never the display handle.
-- Handles change — someone renames their GitHub account and every subscription
-- keyed on the old name silently stops matching, with no error anywhere.
-- external_handle is stored for humans to read and is never joined on.
-- ===========================================================================
create table public.person_identities (
  system          text not null,
  external_id     text not null,
  person_id       text not null references public.people (id) on delete cascade,
  external_handle text,
  -- False when the mapping was inferred (matching emails, say) rather than
  -- confirmed by the person. An unverified identity is good enough to route a
  -- normal memory and must not be trusted for anything sensitive.
  verified        boolean not null default false,
  created_at      timestamptz not null default now(),
  primary key (system, external_id)
);

create index person_identities_person_idx on public.person_identities (person_id);


-- ===========================================================================
-- 4. Vocabulary
--
-- Closed sets are enums so a typo is a write-time error rather than a row that
-- silently never matches a filter. The two that must NOT be enums are
-- origin_vendor and source_system: vendors and external systems are data.
-- ===========================================================================

-- Draft 1's six, plus `constraint` — a durable rule that constrains future
-- work. Separate from `learned` because the two route differently: a
-- constraint is prescriptive and gets pushed at whoever is about to touch the
-- thing, a learning is descriptive and gets pulled. One kind for both means
-- routing cannot tell them apart and either pushes too much or nothing.
create type memory_kind        as enum ('produced','shipped','decided','learned','constraint','blocked','asked');
create type memory_status      as enum ('open','done','blocked','abandoned');
create type memory_confidence  as enum ('stated','observed','inferred');
create type memory_state       as enum ('candidate','shared','retired');
create type memory_scope_type  as enum ('person','team','project','service','org');
create type memory_sensitivity as enum ('normal','confidential','restricted');
create type source_kind        as enum ('ticket','pull_request','incident','commit','document','channel');
create type source_relation    as enum ('about','produced','caused_by');
create type subscription_reason as enum ('assignee','reviewer','reporter','on_call','watcher','manual');


-- ===========================================================================
-- 5. Scopes — the audiences memory attaches to
-- ===========================================================================
create table public.scopes (
  id          text primary key,
  org_id      text not null references public.orgs (id) on delete restrict,
  scope_type  memory_scope_type not null,
  name        text not null,
  -- Nesting, for later. A service belongs to a team; a team belongs to a
  -- department when departments arrive. Nothing traverses this in phase one —
  -- it exists so that when something does, the edges are already recorded.
  parent_id   text references public.scopes (id) on delete set null,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

create index scopes_type_idx   on public.scopes (org_id, scope_type) where archived_at is null;
create index scopes_parent_idx on public.scopes (parent_id) where parent_id is not null;

-- Explicit membership rather than derived from people.team, because a service
-- has members who are not a team and a project draws from several. people.team
-- stays as the historical stamp on the record; this answers "may you see it".
create table public.scope_members (
  scope_id  text not null references public.scopes (id) on delete cascade,
  person_id text not null references public.people (id) on delete cascade,
  added_at  timestamptz not null default now(),
  added_by  text references public.people (id) on delete set null,
  primary key (scope_id, person_id)
);

create index scope_members_person_idx on public.scope_members (person_id);


-- ===========================================================================
-- 6. memory_units — the unit of shared memory
--
-- One table. A personal tier and a shared tier as separate tables would mean
-- two write paths and a permanent question about which one a thing belongs in.
-- scope_type = 'person' IS the personal tier, and promotion is a scope change
-- on the same row.
-- ===========================================================================
create table public.memory_units (
  id            uuid primary key default gen_random_uuid(),
  org_id        text not null references public.orgs (id) on delete restrict,

  occurred_at   timestamptz not null default now(),
  -- Separate from occurred_at because an agent writing up a week of work would
  -- otherwise stamp it all as today, and every "what happened Tuesday" answer
  -- would be wrong. catch_up pages on this one, not occurred_at.
  recorded_at   timestamptz not null default now(),

  person_id     text not null references public.people (id) on delete cascade,

  -- Stamped once on insert and allowed to disagree with people.team later. A
  -- record is a historical fact: reading team live means moving one person
  -- silently rewrites the history of who did what for whom.
  team          text,

  kind          memory_kind not null,
  summary       text not null check (char_length(summary) between 1 and 300),
  detail        text check (detail is null or char_length(detail) <= 20000),

  -- Derived from the bound source when there is one; agent-chosen otherwise.
  -- The derivation lives in the write function, not here, because a constraint
  -- cannot see memory_sources at insert time.
  subject       text not null check (subject ~ '^[a-z0-9][a-z0-9-]{0,79}$'),

  artifacts     jsonb not null default '[]' check (jsonb_typeof(artifacts) = 'array'),

  status        memory_status not null default 'done',
  blocked_on    text,
  needs_from    text references public.people (id) on delete set null,
  supersedes    uuid references public.memory_units (id) on delete set null,
  confidence    memory_confidence not null,
  tags          text[] not null default '{}',

  state         memory_state not null default 'shared',

  scope_type    memory_scope_type not null default 'team',
  scope_id      text references public.scopes (id) on delete restrict,
  sensitivity   memory_sensitivity not null default 'normal',

  -- TEXT, not enums. Vendors are data; an enum here is the hard-coding this
  -- design exists to avoid.
  origin_vendor text,
  origin_agent  text,
  -- The only place a vendor-shaped fact may live. Nothing in the core queries
  -- inside it; it exists so a memory can be traced back to its session.
  origin_ref    jsonb not null default '{}' check (jsonb_typeof(origin_ref) = 'object'),

  promoted_from uuid references public.memory_units (id) on delete set null,
  -- Distinct from person_id: a reviewer can promote an author's memory, and
  -- collapsing the two credits the wrong person in the audit trail.
  promoted_by   text references public.people (id) on delete set null,
  promoted_at   timestamptz,

  verified_at   timestamptz,
  verified_by   text references public.people (id) on delete set null,
  -- Some constraints are true until a migration lands and false after.
  expires_at    timestamptz,

  -- Denormalised so the tsvector can be generated: array_to_string is STABLE,
  -- not IMMUTABLE, so it cannot appear in a generated column. Same trap as
  -- skills.keywords. The trigger below keeps it in step.
  keywords      text not null default '',

  search        tsvector generated always as (
                  setweight(to_tsvector('english', coalesce(summary,  '')), 'A') ||
                  setweight(to_tsvector('english', coalesce(subject,  '')), 'B') ||
                  setweight(to_tsvector('english', coalesce(keywords, '')), 'B') ||
                  setweight(to_tsvector('english', coalesce(detail,   '')), 'C')
                ) stored,

  constraint memory_units_no_self_supersede
    check (supersedes is null or supersedes <> id),

  -- A blocked record with no reason is the one thing here actively worse than
  -- no record at all.
  constraint memory_units_blocked_has_reason
    check (status <> 'blocked' or blocked_on is not null or needs_from is not null),

  -- Without this, a null scope_id on a team-scoped memory means "visible to
  -- nobody" or "visible to everybody" depending on how the predicate is
  -- written, and both are wrong.
  constraint memory_units_scope_id_required
    check (scope_type = 'person' or scope_id is not null),

  constraint memory_units_promotion_complete
    check ((promoted_by is null) = (promoted_at is null)),

  constraint memory_units_verification_complete
    check ((verified_by is null) = (verified_at is null))
);

-- Derives what the caller should not have to supply. team is stamped on INSERT
-- only: re-deriving it on update would undo exactly what the column exists to
-- prevent. An explicitly supplied team is honoured, for backfills.
create function public.memory_units_derive() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.keywords := array_to_string(coalesce(new.tags, '{}'), ' ');

  if tg_op = 'INSERT' then
    if new.team is null then
      select p.team into new.team from public.people p where p.id = new.person_id;
    end if;
    if new.org_id is null then
      select p.org_id into new.org_id from public.people p where p.id = new.person_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger memory_units_derive_biu
  before insert or update of tags on public.memory_units
  for each row execute function public.memory_units_derive();


-- ===========================================================================
-- 7. memory_sources — what the memory is about
--
-- The table the product rests on. A table rather than a jsonb column because
-- routing joins on (source_system, source_kind, source_ref) and needs it
-- indexed — the opposite of artifacts, which nothing queries inside of.
-- ===========================================================================
create table public.memory_sources (
  memory_id     uuid not null references public.memory_units (id) on delete cascade,
  -- TEXT: 'jira', 'github', 'pagerduty', 'linear'. Matches
  -- person_identities.system, and the two must stay spelled the same way or
  -- routing joins silently return nothing.
  source_system text not null,
  source_kind   source_kind not null,
  source_ref    text not null,
  source_url    text,
  relation      source_relation not null default 'about',

  -- Whether the binding was inferred from context or stated by a person. Worth
  -- keeping separate from the memory's own confidence: a fact someone is
  -- certain of can still be attached to the wrong ticket by a branch-name
  -- heuristic.
  inferred      boolean not null default true,
  created_at    timestamptz not null default now(),

  primary key (memory_id, source_system, source_kind, source_ref)
);

-- The routing lookup, "everything bound to this ticket". Leading with the
-- external identity because the frequent question is source -> memories.
create index memory_sources_ref_idx
  on public.memory_sources (source_system, source_kind, source_ref);


-- ===========================================================================
-- 8. memory_subscriptions — who cares about what
--
-- Written by adapters listening to external systems, not by people.
-- ===========================================================================
create table public.memory_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  person_id     text not null references public.people (id) on delete cascade,

  source_system text not null,
  source_kind   source_kind not null,
  source_ref    text not null,

  reason        subscription_reason not null,

  -- Time-bounded. Assignment changes, and a subscription that never expires
  -- turns into a permanent firehose for whoever once touched a ticket. Closing
  -- one must not delete it: the delivery ledger references why something was
  -- sent, and "you were the assignee in August" has to stay answerable.
  active_from   timestamptz not null default now(),
  active_to     timestamptz,
  created_at    timestamptz not null default now()
);

create index memory_subscriptions_ref_idx
  on public.memory_subscriptions (source_system, source_kind, source_ref)
  where active_to is null;

create index memory_subscriptions_person_idx
  on public.memory_subscriptions (person_id)
  where active_to is null;

-- Without this, every webhook redelivery adds a duplicate and the fan-out
-- multiplies silently.
create unique index memory_subscriptions_live_uniq
  on public.memory_subscriptions (person_id, source_system, source_kind, source_ref, reason)
  where active_to is null;


-- ===========================================================================
-- 9. memory_deliveries — outbox and ledger in one table
--
-- Three jobs: idempotency, the audit trail the product promises, and
-- measurement. The third is the one people skip, and without acknowledged_at
-- there is no way to tell whether routing helps or is being ignored, and so no
-- basis for tightening what gets pushed.
--
-- A row with delivered_at null IS the outbox. A separate queue table would
-- need keeping in step with this one, and the ledger already has every column
-- the queue needs.
-- ===========================================================================
create table public.memory_deliveries (
  memory_id         uuid not null references public.memory_units (id) on delete cascade,
  person_id         text not null references public.people (id) on delete cascade,
  reason            subscription_reason not null,
  -- TEXT: 'mcp', 'slack', 'email', 'webhook'. Channels are as much data as
  -- vendors are, and the unit must not know that Claude exists.
  channel           text not null,

  delivered_at      timestamptz,
  acknowledged_at   timestamptz,

  -- Set when a per-session cap or a sensitivity rule held something back.
  -- Recorded rather than dropped, so an over-tuned filter is visible in the
  -- data instead of silently swallowing things.
  suppressed_reason text,

  queued_at         timestamptz not null default now(),

  primary key (memory_id, person_id, channel)
);

create index memory_deliveries_pending_idx
  on public.memory_deliveries (queued_at)
  where delivered_at is null and suppressed_reason is null;

create index memory_deliveries_person_idx
  on public.memory_deliveries (person_id, queued_at desc);


-- ===========================================================================
-- 10. memory_grants — the restricted list
--
-- Consulted only for sensitivity = 'restricted'. Everything else resolves
-- through scope membership.
-- ===========================================================================
create table public.memory_grants (
  memory_id  uuid not null references public.memory_units (id) on delete cascade,
  person_id  text not null references public.people (id) on delete cascade,
  granted_by text not null references public.people (id) on delete restrict,
  granted_at timestamptz not null default now(),
  reason     text,
  primary key (memory_id, person_id)
);

create index memory_grants_person_idx on public.memory_grants (person_id);


-- ===========================================================================
-- 11. memory_feedback — verification and usefulness
--
-- Covers three things draft 1 left open: "this was later found wrong", "this
-- has gone stale", and "this was worth sending me". The third eventually
-- decides what gets routed; without it, tuning the push rules is guesswork.
-- ===========================================================================
create table public.memory_feedback (
  id         uuid primary key default gen_random_uuid(),
  memory_id  uuid not null references public.memory_units (id) on delete cascade,
  person_id  text not null references public.people (id) on delete cascade,
  signal     text not null check (signal in ('confirmed','disputed','stale','useful','noise')),
  note       text,
  created_at timestamptz not null default now(),
  unique (memory_id, person_id, signal)
);

create index memory_feedback_memory_idx on public.memory_feedback (memory_id);


-- ===========================================================================
-- 11A. work_claims — "somebody is already on this"
--
-- The cheapest anti-siloing mechanic in the whole design. One person's
-- assistant says what it is about to work on; a colleague's assistant checks
-- before starting the same thing and is told.
--
-- The tables are created here even though the tools that use them are Phase 3A,
-- because the shape of the record is the expensive thing to change later and
-- the table costs nothing sitting empty.
-- ===========================================================================
create table public.work_claims (
  id            uuid primary key default gen_random_uuid(),
  org_id        text not null references public.orgs (id) on delete restrict,
  person_id     text not null references public.people (id) on delete cascade,
  scope_id      text references public.scopes (id) on delete cascade,

  -- A claim targets either a subject or an external object, and needs at least
  -- one of them. A claim with no target cannot be checked against, so it is
  -- pure noise.
  subject       text check (subject is null or subject ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  source_system text,
  source_kind   source_kind,
  source_ref    text,

  -- One sentence saying what they are about to do. Capped for the same reason
  -- summary is: this is scanned by a person deciding whether to stand down.
  intent        text not null check (char_length(intent) between 1 and 300),

  claimed_at    timestamptz not null default now(),

  -- Auto-expiring, and this is the load-bearing design decision. A claim that
  -- outlives the session that made it is WORSE than no claim: it tells the next
  -- person the work is covered when it was actually abandoned halfway through.
  -- Eight hours is one working day, and the tools release explicitly at session
  -- end rather than relying on the timer.
  expires_at    timestamptz not null default now() + interval '8 hours',
  released_at   timestamptz,

  constraint work_claims_has_target
    check (subject is not null or source_ref is not null),
  -- Half an external reference cannot be matched against anything.
  constraint work_claims_source_complete
    check ((source_ref is null) = (source_system is null))
);

-- "Is anyone on this ticket?" Partial on released_at only: expires_at cannot
-- appear in an index predicate because now() is not immutable, so liveness is
-- filtered at query time against this smaller set.
create index work_claims_source_idx
  on public.work_claims (source_system, source_kind, source_ref)
  where released_at is null;

create index work_claims_subject_idx
  on public.work_claims (subject)
  where released_at is null and subject is not null;

create index work_claims_person_idx
  on public.work_claims (person_id, claimed_at desc);


-- ===========================================================================
-- 11B. scope_notes — the only part of project state that is stored
--
-- Everything else in "where things are at" is computed from the records by
-- get_project_state (a later migration). This holds the part that genuinely
-- cannot be derived: what the team is trying to achieve, and what matters right
-- now. Deliberately tiny, because every field added here is a field that can go
-- stale, and a stale status document is worse than none since people still
-- trust it.
-- ===========================================================================
create table public.scope_notes (
  scope_id      text primary key references public.scopes (id) on delete cascade,
  goal          text check (goal          is null or char_length(goal)          <= 2000),
  current_focus text check (current_focus is null or char_length(current_focus) <= 2000),
  updated_by    text references public.people (id) on delete set null,
  updated_at    timestamptz not null default now()
);


-- ===========================================================================
-- 12. Indexes on memory_units — one per question, and no more
--
-- Draft 1's index list was built from the shape of the record and missed the
-- most frequently run query in the system. This one is built from the
-- questions. The partial `state = 'shared'` predicates matter: candidates are
-- expected to outnumber shared units and must not bloat the read indexes.
-- ===========================================================================
create index memory_units_person_time_idx  on public.memory_units (person_id, occurred_at desc);

-- The polling query, run by every agent on every check. Compound with id
-- because the cursor is (recorded_at, id): an agent recording a burst writes
-- several rows in the same instant, and a timestamp-only cursor either repeats
-- them or drops them.
create index memory_units_recorded_idx     on public.memory_units (recorded_at, id) where state = 'shared';

create index memory_units_kind_time_idx    on public.memory_units (kind, occurred_at desc) where state = 'shared';
create index memory_units_scope_time_idx   on public.memory_units (scope_type, scope_id, occurred_at desc) where state = 'shared';
create index memory_units_subject_time_idx on public.memory_units (subject, occurred_at);
create index memory_units_open_idx         on public.memory_units (status, occurred_at desc) where status in ('open','blocked');
create index memory_units_needs_from_idx   on public.memory_units (needs_from) where needs_from is not null;
create index memory_units_supersedes_idx   on public.memory_units (supersedes) where supersedes is not null;
create index memory_units_candidates_idx   on public.memory_units (person_id, recorded_at desc) where state = 'candidate';
create index memory_units_search_idx       on public.memory_units using gin (search);
create index memory_units_tags_idx         on public.memory_units using gin (tags);


-- ===========================================================================
-- 13. current_memory — everything nothing else has replaced
--
-- security_invoker is NOT optional. A view runs as its owner by default, reads
-- straight past the row-level security below, and hands every restricted
-- record to anyone who selects from it. The RLS would look correct, the tables
-- would be locked down, and the leak would be through the convenience view
-- nobody re-checked. This exact bug was in draft 1 and was found by running
-- it, not by reading it.
-- ===========================================================================
create view public.current_memory with (security_invoker = true) as
  select m.*
  from public.memory_units m
  where m.state = 'shared'
    and (m.expires_at is null or m.expires_at > now())
    and not exists (select 1 from public.memory_units s where s.supersedes = m.id);


-- ===========================================================================
-- 14. Visibility — ONE predicate
--
-- The most dangerous thing in this file, and more dangerous than it was in
-- draft 1, because routing is the first mechanism here that moves a memory to
-- someone who did not ask for it. The service-role path bypasses RLS
-- entirely, so a missing check in one function leaks everything through that
-- one tool while the tables' RLS looks perfectly correct. A router that skips
-- this predicate is that bug with a delivery mechanism attached.
--
-- One function. Called by the RLS policy, by every read RPC, and by the
-- router. No second copy of the logic anywhere.
--
-- PERFORMANCE: this is a function call with subqueries per row, where draft 1
-- had learned to compare a column. That was a deliberate trade for
-- correctness, and it is the thing to EXPLAIN ANALYZE on real volume before
-- trusting. If it does not hold up, the fix is a materialised membership
-- column, not a second copy of the predicate.
-- ===========================================================================
create function public.can_see_memory(
  p_memory_id   uuid,
  p_org_id      text,
  p_scope_type  memory_scope_type,
  p_scope_id    text,
  p_sensitivity memory_sensitivity,
  p_owner       text,
  p_viewer      text
) returns boolean
language sql stable security definer set search_path = public as $$
  select
    -- The viewer must exist AND be in the same org. Not redundant: draft 1
    -- shipped without the existence check and an unrecognised viewer matched
    -- the company branch, so a mistyped or spoofed header read the entire
    -- company feed. Found by calling the function with a made-up id, not by
    -- reading it.
        p_viewer is not null
    and exists (
          select 1 from public.people
          where id = p_viewer and org_id = p_org_id
        )
    and (
      p_owner = p_viewer
      or case p_sensitivity
           -- Explicit grant list and nobody else, regardless of scope.
           when 'restricted' then
             exists (select 1 from public.memory_grants g
                     where g.memory_id = p_memory_id and g.person_id = p_viewer)
           -- normal and confidential both resolve through scope membership.
           -- They differ in ROUTING and export, not in read access.
           else
             case p_scope_type
               when 'org'    then true
               when 'person' then false   -- already covered by p_owner above
               else exists (select 1 from public.scope_members sm
                            where sm.scope_id = p_scope_id and sm.person_id = p_viewer)
             end
         end
    );
$$;


-- ===========================================================================
-- 15. Row-level security
-- ===========================================================================
alter table public.orgs                 enable row level security;
alter table public.person_identities    enable row level security;
alter table public.scopes               enable row level security;
alter table public.scope_members        enable row level security;
alter table public.memory_units         enable row level security;
alter table public.memory_sources       enable row level security;
alter table public.memory_subscriptions enable row level security;
alter table public.memory_deliveries    enable row level security;
alter table public.memory_grants        enable row level security;
alter table public.memory_feedback      enable row level security;
alter table public.work_claims          enable row level security;
alter table public.scope_notes          enable row level security;

create policy memory_units_read on public.memory_units
  for select to authenticated
  using (public.can_see_memory(
           id, org_id, scope_type, scope_id, sensitivity,
           person_id, public.current_person_id()));

-- You may only write your own, and only into a scope you belong to. The second
-- half is decision 5: promotion authority enforced here rather than left to
-- convention. Ownership compares an id the caller does not choose, so there is
-- no way to phrase the request that gets around it.
create policy memory_units_write on public.memory_units
  for insert to authenticated
  with check (
    person_id = public.current_person_id()
    and (
      scope_type = 'person'
      or exists (select 1 from public.scope_members sm
                 where sm.scope_id = memory_units.scope_id
                   and sm.person_id = public.current_person_id())
    )
  );

create policy memory_units_update on public.memory_units
  for update to authenticated
  using      (person_id = public.current_person_id())
  with check (person_id = public.current_person_id());

-- Sources are readable exactly when their memory is. Written out rather than
-- assumed: a source row names a ticket, and which tickets a private memory
-- touches is itself information.
create policy memory_sources_read on public.memory_sources
  for select to authenticated
  using (exists (
    select 1 from public.memory_units m
    where m.id = memory_sources.memory_id
      and public.can_see_memory(m.id, m.org_id, m.scope_type, m.scope_id,
                                m.sensitivity, m.person_id,
                                public.current_person_id())));

create policy memory_deliveries_read on public.memory_deliveries
  for select to authenticated
  using (person_id = public.current_person_id());

create policy memory_feedback_write on public.memory_feedback
  for insert to authenticated
  with check (person_id = public.current_person_id());

-- Read-only reference data for signed-in users. Scope membership is not
-- secret; what is in a scope is.
create policy scopes_read        on public.scopes        for select to authenticated using (true);
create policy scope_members_read on public.scope_members for select to authenticated using (true);

-- Claims are readable across your own org, because their entire purpose is that
-- a colleague sees them before duplicating your work. Scoped to the org rather
-- than left open: who is working on what is ordinary inside a company and
-- sensitive outside one.
create policy work_claims_read on public.work_claims
  for select to authenticated
  using (exists (select 1 from public.people p
                 where p.id = public.current_person_id()
                   and p.org_id = work_claims.org_id));

-- You may only claim as yourself, and only release your own.
create policy work_claims_write on public.work_claims
  for insert to authenticated
  with check (person_id = public.current_person_id());

create policy work_claims_release on public.work_claims
  for update to authenticated
  using      (person_id = public.current_person_id())
  with check (person_id = public.current_person_id());

-- Project notes are readable by members of the scope they describe, and
-- writable by them too. Anyone doing the work can say what the work is for.
create policy scope_notes_read on public.scope_notes
  for select to authenticated
  using (exists (select 1 from public.scope_members sm
                 where sm.scope_id = scope_notes.scope_id
                   and sm.person_id = public.current_person_id()));

create policy scope_notes_write on public.scope_notes
  for all to authenticated
  using      (exists (select 1 from public.scope_members sm
                      where sm.scope_id = scope_notes.scope_id
                        and sm.person_id = public.current_person_id()))
  with check (exists (select 1 from public.scope_members sm
                      where sm.scope_id = scope_notes.scope_id
                        and sm.person_id = public.current_person_id()));


-- ===========================================================================
-- 16. Grants
--
-- The trap this project has now hit twice: Postgres grants EXECUTE to PUBLIC
-- on every new function, and Supabase ALSO grants to anon and authenticated BY
-- NAME through default privileges. Revoking from PUBLIC alone is correct on
-- stock Postgres and insufficient here. That gap left two write functions
-- reachable by anon in the skills schema and the database linter did not catch
-- it. Verify with:
--
--   select proname, array_to_string(proacl::text[], ' | ')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public';
--
-- The counter-trap: an RLS policy expression is evaluated as the querying
-- role, so a policy calling a SECURITY DEFINER helper still needs that role to
-- hold EXECUTE on it. Revoking can_see_memory from `authenticated` does not
-- tighten the policy, it breaks it — every signed-in user gets "permission
-- denied for function" on every select, which reads as a broken app rather
-- than a misapplied grant.
-- ===========================================================================
grant execute on function public.can_see_memory(uuid, text, memory_scope_type, text, memory_sensitivity, text, text) to authenticated;
revoke execute on function public.can_see_memory(uuid, text, memory_scope_type, text, memory_sensitivity, text, text) from public, anon;
revoke execute on function public.memory_units_derive() from public, anon, authenticated;

-- RLS restricts which rows a role sees; it does not grant access to the table
-- in the first place, so without these the policies have nothing to filter.
grant select, insert, update on public.memory_units      to authenticated;
grant select                 on public.current_memory    to authenticated;
grant select, insert         on public.memory_sources    to authenticated;
grant select                 on public.memory_deliveries to authenticated;
grant select, insert         on public.memory_feedback   to authenticated;
grant select                 on public.scopes, public.scope_members to authenticated;
grant select, insert, update on public.work_claims      to authenticated;
grant select, insert, update, delete on public.scope_notes to authenticated;

revoke all on public.memory_units, public.memory_sources, public.memory_subscriptions,
              public.memory_deliveries, public.memory_grants, public.memory_feedback,
              public.person_identities, public.orgs, public.scopes, public.scope_members,
              public.work_claims, public.scope_notes
       from anon;

-- Supabase grants SELECT on new views to anon by default, so this one arrives
-- reachable. security_invoker already makes it harmless, but a view anon can
-- name is one security_invoker slip away from being a leak, and revoking is
-- free.
revoke all on public.current_memory from anon;

commit;


-- ===========================================================================
-- Deliberately NOT in this file
-- ===========================================================================
--
-- The RPCs. record_memory, find_memory, whats_blocked, who_worked_on,
-- catch_up and promote_memory all need rewriting against can_see_memory, and
-- catch_up needs extending to return routed deliveries rather than only recent
-- records. They are a second migration because the tables are worth agreeing
-- before the surface over them is.
--
-- get_project_state(scope, viewer), claim_work, check_claims and release_work.
-- Phase 3A. get_project_state must COMPUTE the picture from the records on
-- every call and store nothing: goal and current focus from scope_notes, then
-- recent decisions, live constraints, open blockers and active claims read
-- straight from current_memory and work_claims. The moment it caches, it is a
-- hand-maintained status document with extra steps, and a stale one is worse
-- than none because people still trust it.
--
-- Every one of them filters through can_see_memory, including the claims. A
-- claim names a person and a ticket, and who is working on what is not
-- automatically harmless.
--
-- The router. route_memory() and the subscription backfill are the third
-- migration, and the one to write most carefully — see section 14.
--
-- Seed data. No scopes and no org beyond 'default' are created here. A scope
-- registry seeded with guesses is worse than an empty one.
