-- Shared team memory — proposed schema, draft 2. 20 August 2026.
--
-- *** NOT APPLIED ANYWHERE. NOT RUN. FOR REVIEW ONLY. ***
--
-- This is a proposal measured against draft 1 (schema.sql in this folder), which
-- WAS applied and tested against Postgres 17. It has NOT been reconciled with
-- whatever exists in ddutche/claude-comms or the ddutche Supabase, because I
-- could not read either in the session that wrote this. Reconcile first. If the
-- names there differ, the names here lose.
--
-- Read shared-memory-plan.md alongside this. Every "why" lives there; this file
-- carries only the reasoning that is invisible from the plan.
--
-- Depends on public.people (id text primary key, display_name, email, team).


-- ===========================================================================
-- 1. Vocabulary
--
-- Closed sets stay enums so a typo is a write-time error rather than a row that
-- silently never matches a filter. The two things that must NOT be enums are
-- origin_vendor and source_system: vendors and external systems are data, and
-- an enum there is precisely the hard-coding this design exists to avoid.
-- ===========================================================================

-- Draft 1's six plus `constraint`. See the plan: a constraint is prescriptive
-- and gets pushed at whoever is about to touch the thing it constrains, where a
-- learning is descriptive and gets pulled. Sharing a kind means routing cannot
-- tell them apart.
--
-- Note the quoting: `constraint` is a reserved word in SQL. It is fine as an
-- enum LABEL (labels are string literals, not identifiers) but it will need
-- quoting in some contexts and is a live papercut. If review prefers a
-- non-reserved word, `rule` and `invariant` are the candidates. Flagging it
-- rather than silently picking, because the vocabulary is the expensive thing
-- to change later.
create type memory_kind as enum (
  'produced', 'shipped', 'decided', 'learned', 'constraint', 'blocked', 'asked'
);

create type memory_status      as enum ('open', 'done', 'blocked', 'abandoned');
create type memory_confidence  as enum ('stated', 'observed', 'inferred');

-- The promotion lifecycle. A candidate is not searchable and is not routed,
-- which is the entire reason flag_candidate can be free of confirmation.
create type memory_state       as enum ('candidate', 'shared', 'retired');

-- Audience. Extends past `team` because "everyone who touches the payments
-- service" is the scoping engineers actually want and a team column cannot
-- express it. New values are addable later without touching any other column,
-- which is how departments arrive in a later phase.
create type memory_scope_type  as enum ('person', 'team', 'project', 'service', 'org');

-- Handling. Orthogonal to audience — see the plan. This split is the change
-- that cannot be retrofitted.
create type memory_sensitivity as enum ('normal', 'confidential', 'restricted');

create type source_kind        as enum (
  'ticket', 'pull_request', 'incident', 'commit', 'document', 'channel'
);

-- How the memory relates to the source it is bound to.
create type source_relation    as enum ('about', 'produced', 'caused_by');

create type subscription_reason as enum (
  'assignee', 'reviewer', 'reporter', 'on_call', 'watcher', 'manual'
);


-- ===========================================================================
-- 2. scopes — the audiences memory can be attached to
--
-- A registry rather than free text, so a memory scoped to a service that does
-- not exist is a foreign key error instead of a row nobody ever sees. Same
-- argument as the subject slug in draft 1, but enforceable, because unlike
-- subjects these are administered rather than guessed by an agent.
-- ===========================================================================
create table public.scopes (
  id          text primary key,          -- e.g. 'svc-payments', 'team-platform'
  scope_type  memory_scope_type not null,
  name        text not null,
  -- Nesting, for later. A service belongs to a team; a team belongs to a
  -- department when departments arrive. Nothing in phase one traverses this —
  -- it exists so that when something does, the edges are already recorded.
  parent_id   text references public.scopes (id) on delete set null,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);

create index scopes_type_idx   on public.scopes (scope_type) where archived_at is null;
create index scopes_parent_idx on public.scopes (parent_id)  where parent_id is not null;

-- Membership. Who is in a scope, for the audience half of visibility.
--
-- Explicit rather than derived from people.team, because a service has members
-- who are not a team and a project has members from several teams. people.team
-- stays as the historical stamp on the record; this answers "may this person
-- see it".
create table public.scope_members (
  scope_id   text not null references public.scopes (id) on delete cascade,
  person_id  text not null references public.people (id) on delete cascade,
  added_at   timestamptz not null default now(),
  added_by   text references public.people (id) on delete set null,
  primary key (scope_id, person_id)
);

create index scope_members_person_idx on public.scope_members (person_id);


-- ===========================================================================
-- 3. memory_units — the unit of shared memory
--
-- Successor to work_records. One table, not two: a personal tier and a shared
-- tier as separate tables would mean two write paths, a reconciliation problem
-- forever, and a permanent question about which one a thing belongs in.
-- `scope_type = 'person'` IS the personal tier.
-- ===========================================================================
create table public.memory_units (
  id           uuid primary key default gen_random_uuid(),

  -- Isolated per-company deployments mean this is single-valued in practice.
  -- It is here because it cannot be retrofitted and because an RLS predicate
  -- below actually enforces it. An unenforced tenant column is worse than no
  -- tenant column: it looks like isolation and is not.
  org_id       text not null,

  -- ---- carried from draft 1, unchanged in meaning ----
  occurred_at  timestamptz not null default now(),
  recorded_at  timestamptz not null default now(),

  -- Always a person. An agent acts on someone's behalf, and attributing to the
  -- agent loses the only column anyone wants to group by.
  person_id    text not null references public.people (id) on delete cascade,

  -- Stamped once on insert, allowed to disagree with people.team later. A
  -- record is a historical fact: reading team live means moving one person
  -- silently rewrites the history of who did what for whom.
  team         text,

  kind         memory_kind not null,
  summary      text not null check (char_length(summary) between 1 and 300),
  detail       text check (detail is null or char_length(detail) <= 20000),

  -- Still slug-constrained. See the open question in the plan: now that memory
  -- binds to tickets and PRs, a ticket is a better thread identity than a slug
  -- an agent guessed, and this field may be on its way out.
  subject      text not null check (subject ~ '^[a-z0-9][a-z0-9-]{0,79}$'),

  artifacts    jsonb not null default '[]' check (jsonb_typeof(artifacts) = 'array'),

  status       memory_status not null default 'done',
  blocked_on   text,
  needs_from   text references public.people (id) on delete set null,
  supersedes   uuid references public.memory_units (id) on delete set null,
  confidence   memory_confidence not null,
  tags         text[] not null default '{}',

  -- ---- new: lifecycle ----
  state        memory_state not null default 'shared',

  -- ---- new: audience and handling, replacing draft 1's single `visibility` ----
  scope_type   memory_scope_type not null default 'team',
  scope_id     text references public.scopes (id) on delete restrict,
  sensitivity  memory_sensitivity not null default 'normal',

  -- ---- new: vendor-agnostic provenance ----
  --
  -- Text, not enums. This is rule 2 of the vendor-agnosticism rules in the plan
  -- and the single most load-bearing typing decision in the file.
  origin_vendor text,                    -- 'anthropic', 'openai', ...
  origin_agent  text,                    -- 'claude-code', ...
  -- The ONLY place a vendor-shaped fact is allowed to live. Nothing in the core
  -- queries inside it; it exists so a memory can be traced back to its session.
  origin_ref    jsonb not null default '{}' check (jsonb_typeof(origin_ref) = 'object'),

  -- ---- new: promotion audit ----
  promoted_from uuid references public.memory_units (id) on delete set null,
  -- Distinct from person_id on purpose: a reviewer can promote an author's
  -- memory, and collapsing the two would credit the wrong person in the audit
  -- trail the product promises.
  promoted_by   text references public.people (id) on delete set null,
  promoted_at   timestamptz,

  -- ---- new: staleness, closing the gap SCHEMA.md left open ----
  verified_at   timestamptz,
  verified_by   text references public.people (id) on delete set null,
  -- Some constraints are true until a migration lands and false after.
  expires_at    timestamptz,

  keywords     text not null default '',

  search       tsvector generated always as (
                 setweight(to_tsvector('english', coalesce(summary,  '')), 'A') ||
                 setweight(to_tsvector('english', coalesce(subject,  '')), 'B') ||
                 setweight(to_tsvector('english', coalesce(keywords, '')), 'B') ||
                 setweight(to_tsvector('english', coalesce(detail,   '')), 'C')
               ) stored,

  constraint memory_units_no_self_supersede
    check (supersedes is null or supersedes <> id),

  constraint memory_units_blocked_has_reason
    check (status <> 'blocked' or blocked_on is not null or needs_from is not null),

  -- A person-scoped memory is scoped to its author and needs no scope row; every
  -- other scope type must name one. Without this, scope_id null on a team-scoped
  -- memory means "visible to nobody" or "visible to everybody" depending on how
  -- the predicate is written, and both are wrong.
  constraint memory_units_scope_id_required
    check (scope_type = 'person' or scope_id is not null),

  -- Promotion is stamped atomically or not at all.
  constraint memory_units_promotion_complete
    check ((promoted_by is null) = (promoted_at is null))
);


-- ===========================================================================
-- 4. memory_sources — what the memory is about
--
-- The table the whole product rests on. Routing joins on
-- (source_system, source_kind, source_ref), which is why this is a table and
-- not a jsonb column the way artifacts is: nothing queries inside an artifact,
-- and everything queries inside this.
-- ===========================================================================
create table public.memory_sources (
  memory_id     uuid not null references public.memory_units (id) on delete cascade,

  -- TEXT, deliberately. 'jira', 'github', 'pagerduty', 'linear'. Rule 2 again.
  source_system text not null,
  source_kind   source_kind not null,
  -- The external identifier as that system spells it: 'PROJ-123', 'acme/api#456'.
  source_ref    text not null,
  source_url    text,
  relation      source_relation not null default 'about',

  -- Whether this binding was inferred from context or stated by a person. The
  -- same distinction confidence makes about content, applied to the binding —
  -- and worth keeping separate, because a memory a person is sure of can still
  -- be attached to the wrong ticket by a branch-name heuristic.
  inferred      boolean not null default true,
  created_at    timestamptz not null default now(),

  primary key (memory_id, source_system, source_kind, source_ref)
);

-- The routing lookup: "everything bound to this ticket". Leading with the
-- external identity rather than the memory id, because the frequent question is
-- source -> memories, not memories -> source.
create index memory_sources_ref_idx
  on public.memory_sources (source_system, source_kind, source_ref);


-- ===========================================================================
-- 5. memory_subscriptions — who cares about what
--
-- Written by adapters listening to the external systems, not by people. A Jira
-- webhook on assignment, a GitHub webhook on review_requested, a PagerDuty
-- webhook on on-call handoff.
-- ===========================================================================
create table public.memory_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  person_id     text not null references public.people (id) on delete cascade,

  source_system text not null,
  source_kind   source_kind not null,
  source_ref    text not null,

  reason        subscription_reason not null,

  -- Time-bounded on purpose. Assignment changes, and a subscription that never
  -- expires turns into a permanent firehose for whoever once touched a ticket.
  -- Closing a subscription must not delete it: the delivery ledger references
  -- why something was sent, and "you were the assignee in August" has to stay
  -- answerable.
  active_from   timestamptz not null default now(),
  active_to     timestamptz,

  created_at    timestamptz not null default now()
);

-- "Who should get memories about this ticket, right now."
create index memory_subscriptions_ref_idx
  on public.memory_subscriptions (source_system, source_kind, source_ref)
  where active_to is null;

-- "What am I subscribed to" — the backward direction, run when a person is newly
-- assigned and needs the ticket's whole history.
create index memory_subscriptions_person_idx
  on public.memory_subscriptions (person_id)
  where active_to is null;

-- One live subscription per person per source per reason. Without this, every
-- webhook redelivery adds a duplicate and the fan-out multiplies silently.
create unique index memory_subscriptions_live_uniq
  on public.memory_subscriptions (person_id, source_system, source_kind, source_ref, reason)
  where active_to is null;


-- ===========================================================================
-- 6. memory_deliveries — the ledger
--
-- Idempotency, the audit trail, and measurement. The third is the one people
-- skip: without acknowledged_at there is no way to tell whether routing helps
-- or is being ignored, and therefore no basis for tightening what gets pushed.
-- ===========================================================================
create table public.memory_deliveries (
  memory_id        uuid not null references public.memory_units (id) on delete cascade,
  person_id        text not null references public.people (id) on delete cascade,

  reason           subscription_reason not null,
  -- TEXT, not an enum: 'mcp', 'slack', 'email', 'webhook'. Channels are as much
  -- data as vendors are, and the unit must not know that Claude exists.
  channel          text not null,

  -- Null until the worker drains the outbox. A row with delivered_at null IS
  -- the outbox — a separate queue table would need keeping in step with this
  -- one, and the ledger already has every column the queue needs.
  delivered_at     timestamptz,
  acknowledged_at  timestamptz,

  -- Set when the per-session cap or a sensitivity rule held something back.
  -- Recorded rather than dropped, so an over-tuned filter is visible in the data
  -- instead of silently swallowing things.
  suppressed_reason text,

  queued_at        timestamptz not null default now(),

  primary key (memory_id, person_id, channel)
);

-- The outbox drain.
create index memory_deliveries_pending_idx
  on public.memory_deliveries (queued_at)
  where delivered_at is null and suppressed_reason is null;

-- "What is waiting for me" and "what have I already been sent".
create index memory_deliveries_person_idx
  on public.memory_deliveries (person_id, queued_at desc);


-- ===========================================================================
-- 7. memory_grants — the restricted list
--
-- Only consulted for sensitivity = 'restricted'. Everything else resolves
-- through scope membership.
-- ===========================================================================
create table public.memory_grants (
  memory_id   uuid not null references public.memory_units (id) on delete cascade,
  person_id   text not null references public.people (id) on delete cascade,
  granted_by  text not null references public.people (id) on delete restrict,
  granted_at  timestamptz not null default now(),
  reason      text,
  primary key (memory_id, person_id)
);

create index memory_grants_person_idx on public.memory_grants (person_id);


-- ===========================================================================
-- 8. memory_feedback — verification and usefulness
--
-- One table covering three things SCHEMA.md left open: "this was later found
-- wrong", "this has gone stale", and "this was worth sending me". The third is
-- what eventually decides what gets routed; without it, tuning the push rules
-- is guesswork.
-- ===========================================================================
create table public.memory_feedback (
  id         uuid primary key default gen_random_uuid(),
  memory_id  uuid not null references public.memory_units (id) on delete cascade,
  person_id  text not null references public.people (id) on delete cascade,
  signal     text not null check (signal in ('confirmed', 'disputed', 'stale', 'useful', 'noise')),
  note       text,
  created_at timestamptz not null default now()
);

create index memory_feedback_memory_idx on public.memory_feedback (memory_id);


-- ===========================================================================
-- 9. Indexes on memory_units — one per question, and no more
--
-- Draft 1's index list was built from the shape of the record and missed the
-- most frequently run query in the system. This list is built from the
-- questions. The partial `state = 'shared'` predicates matter: candidates are
-- expected to outnumber shared units and must not bloat the indexes that serve
-- reads.
-- ===========================================================================
create index memory_units_person_time_idx
  on public.memory_units (person_id, occurred_at desc);

-- The polling query. Compound with id because the cursor is (recorded_at, id):
-- an agent recording a burst writes several rows in the same instant.
create index memory_units_recorded_idx
  on public.memory_units (recorded_at, id) where state = 'shared';

create index memory_units_kind_time_idx
  on public.memory_units (kind, occurred_at desc) where state = 'shared';

create index memory_units_scope_time_idx
  on public.memory_units (scope_type, scope_id, occurred_at desc) where state = 'shared';

create index memory_units_subject_time_idx
  on public.memory_units (subject, occurred_at);

create index memory_units_open_idx
  on public.memory_units (status, occurred_at desc)
  where status in ('open', 'blocked');

create index memory_units_needs_from_idx
  on public.memory_units (needs_from) where needs_from is not null;

create index memory_units_supersedes_idx
  on public.memory_units (supersedes) where supersedes is not null;

-- The candidate sweep at session end.
create index memory_units_candidates_idx
  on public.memory_units (person_id, recorded_at desc) where state = 'candidate';

create index memory_units_search_idx on public.memory_units using gin (search);
create index memory_units_tags_idx   on public.memory_units using gin (tags);


-- ===========================================================================
-- 10. current_memory — everything nothing else has replaced
--
-- security_invoker is NOT optional. A view runs as its owner by default, reads
-- straight past the row-level security below, and hands every restricted record
-- to anyone who selects from it. The RLS would look correct, the table would be
-- locked down, and the leak would be through the convenience view nobody
-- re-checked. This exact bug was in draft 1 and was found by running it, not by
-- reading it.
-- ===========================================================================
create view public.current_memory with (security_invoker = true) as
  select m.*
  from public.memory_units m
  where m.state = 'shared'
    and (m.expires_at is null or m.expires_at > now())
    and not exists (
      select 1 from public.memory_units s where s.supersedes = m.id
    );


-- ===========================================================================
-- 11. Visibility — ONE predicate
--
-- The most dangerous property of this schema, and it gets worse in draft 2 than
-- it was in draft 1, because routing is the first thing here that moves a memory
-- to somebody who did not ask for it. The service-role path bypasses RLS
-- entirely, so a missing can_see() in one function leaks everything through that
-- one tool while the table's RLS looks perfectly correct. A router that skips
-- the predicate is that bug with a delivery mechanism attached.
--
-- One function. Called by the RLS policy, by every read RPC, and by the router.
-- No exceptions, and no second copy of the logic anywhere.
--
-- SKETCHED, not final — the org_id and grant lookups want measuring before this
-- goes anywhere near a hot path.
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
    -- The viewer must exist. Not redundant: draft 1 shipped without this and an
    -- unrecognised viewer matched the company branch, so a mistyped or spoofed
    -- header read the entire company feed. Found by calling the function with a
    -- made-up id, not by reading it.
        p_viewer is not null
    and exists (
          select 1 from public.people
          where id = p_viewer and org_id is not distinct from p_org_id
        )
    and (
      -- Your own, always.
      p_owner = p_viewer
      or (
        case p_sensitivity
          -- Explicit grant list and nobody else, regardless of scope.
          when 'restricted' then
            exists (select 1 from public.memory_grants g
                    where g.memory_id = p_memory_id and g.person_id = p_viewer)
          -- normal and confidential both resolve through scope membership. They
          -- differ in ROUTING and export, not in read access — see the plan.
          else
            case p_scope_type
              when 'org'    then true
              when 'person' then false            -- already covered by p_owner
              else exists (select 1 from public.scope_members sm
                           where sm.scope_id = p_scope_id and sm.person_id = p_viewer)
            end
        end
      )
    );
$$;

-- NOTE: this assumes people gains an org_id column. That is a change to a table
-- this file does not own, and it is listed in the reconciliation notes below
-- rather than written here.


-- ===========================================================================
-- 12. Grants
--
-- The trap this project has now hit twice: Postgres grants EXECUTE to PUBLIC on
-- every new function, and Supabase ALSO grants to anon and authenticated BY NAME
-- through default privileges. Revoking from PUBLIC alone is correct on stock
-- Postgres and insufficient here. This exact gap left two write functions
-- reachable by anon in the skills schema, and the database linter did not catch
-- it. Only reading proacl directly did:
--
--   select proname, array_to_string(proacl::text[], ' | ')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public';
--
-- And the counter-trap: an RLS policy expression is evaluated as the querying
-- role, so a policy calling a SECURITY DEFINER helper still needs that role to
-- hold EXECUTE on it. Revoking from `authenticated` does not tighten the policy,
-- it breaks it — every signed-in user gets "permission denied for function" on
-- every select, which reads as a broken app rather than a misapplied grant.
-- ===========================================================================
-- Deliberately left to the migration that applies this, because the grant set
-- depends on which paths exist (PostgREST? web view? MCP only?) and guessing it
-- here would produce exactly the confident-and-wrong grant list that caused the
-- problem the first two times.


-- ===========================================================================
-- Reconciliation notes — what this proposal assumes and does not own
-- ===========================================================================
--
-- 1. public.people gains org_id. Needed by can_see_memory. Not written here
--    because that table belongs to the skills schema.
--
-- 2. public.people needs a stable mapping to external identities — a GitHub
--    login is not an email and a Jira account id is neither. Routing cannot
--    work without it: a webhook says "assigned to gh:someuser" and there has to
--    be a way to reach a person_id from that. This is a missing table
--    (person_identities: person_id, system, external_id) and it is a
--    prerequisite, not a nice-to-have. It is the largest single gap in this
--    draft.
--
-- 3. work_records, if it exists in the ddutche database, needs either a rename
--    or a migration into memory_units. Draft 1 was only ever applied to a
--    sandbox project, so a clean rename is probably still available — that
--    window closes the moment anything real is written.
--
-- 4. The five RPCs in functions.sql (record_work, find_work, whats_blocked,
--    who_worked_on, catch_up) all take p_viewer and all call can_see(). They
--    need rewriting against can_see_memory, and catch_up needs extending to
--    return routed deliveries rather than only recent records.
--
-- 5. pg_trgm is already installed (draft 1 uses similarity() for the
--    similar_subjects hint). Nothing new is needed.
