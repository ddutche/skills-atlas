-- The work record. See SCHEMA.md in this folder for why it is shaped this way.
--
-- Draft 1, 11 August 2026. APPLIED AND TESTED against Postgres 17 on Supabase
-- project overmssglaikxnwtfvoc. Two bugs were found by running it that reading
-- it had not caught: the current_work view bypassed RLS without
-- security_invoker, and revoking EXECUTE on the policy helpers from
-- `authenticated` broke every read for signed-in users. Both are fixed below
-- and both are commented where they were.
--
-- Depends on public.people (id text primary key) from the skills schema.

-- ---------------------------------------------------------------------------
-- enums
--
-- Closed sets rather than text, so a typo is an error at write time instead of
-- a row that silently never matches a filter. The cost is that adding a value
-- is a migration, which is the correct amount of friction for a vocabulary
-- every stored query depends on.
-- ---------------------------------------------------------------------------
create type work_kind       as enum ('produced', 'shipped', 'decided', 'learned', 'blocked', 'asked');
create type work_status     as enum ('open', 'done', 'blocked', 'abandoned');
create type work_confidence as enum ('stated', 'observed', 'inferred');
create type work_visibility as enum ('private', 'team', 'company');

-- ---------------------------------------------------------------------------
-- the table
-- ---------------------------------------------------------------------------
create table public.work_records (
  id           uuid primary key default gen_random_uuid(),

  -- When the work happened, and when it was written down. Separate because an
  -- agent catching up on a week of work would otherwise stamp it all as today,
  -- and every "what happened Tuesday" answer would be wrong.
  occurred_at  timestamptz not null default now(),
  recorded_at  timestamptz not null default now(),

  -- Whose work it is. Always a person: an agent acts on someone's behalf and
  -- attributing to the agent loses the only column anyone wants to group by.
  person_id    text not null references public.people (id) on delete cascade,

  -- The team the work was done in, stamped at write time by the trigger below.
  --
  -- Denormalised from people.team on purpose, and it is allowed to disagree
  -- with it later. People change teams, and a record is a historical fact: if
  -- team were only ever read live from people, moving one person would
  -- silently rewrite the history of who did what for whom. It also removes a
  -- per-row function call from the visibility policy.
  team         text,

  -- Which assistant wrote it. Null when a human recorded it directly. Kept
  -- because "everything my agent did while I was asleep" is a question people
  -- will ask on day one.
  agent        text,

  kind         work_kind not null,

  -- One plain sentence. The cap is a design constraint, not storage thrift:
  -- summaries are what a person scans, and an unbounded one becomes a wall.
  summary      text not null check (char_length(summary) between 1 and 300),
  detail       text check (detail is null or char_length(detail) <= 20000),

  -- The join key. See SCHEMA.md — this is the field most likely to go wrong,
  -- because free text invites forty spellings of one thing. Constrained to a
  -- slug so at least the obvious variants collapse.
  subject      text not null check (subject ~ '^[a-z0-9][a-z0-9-]{0,79}$'),

  -- [{ "kind": "doc", "label": "...", "url": "..." }]. Deliberately not a table:
  -- nothing queries inside an artifact, only follows it, and a jsonb column
  -- keeps the write a single insert. Revisit if that stops being true.
  artifacts    jsonb not null default '[]' check (jsonb_typeof(artifacts) = 'array'),

  status       work_status not null default 'done',
  blocked_on   text,
  needs_from   text references public.people (id) on delete set null,

  -- The record this replaces. See SCHEMA.md: "current" is derived from this
  -- rather than maintained, so nothing has to be kept in step by hand.
  supersedes   uuid references public.work_records (id) on delete set null,

  confidence   work_confidence not null,
  visibility   work_visibility not null default 'team',
  tags         text[] not null default '{}',

  -- Denormalised so the tsvector below can be generated.
  --
  -- array_to_string is STABLE, not IMMUTABLE, so it cannot appear in a
  -- generated column — Postgres refuses. Same trap as skills.keywords in the
  -- other schema. The trigger keeps it in step.
  keywords     text not null default '',

  search       tsvector generated always as (
                 setweight(to_tsvector('english', coalesce(summary,  '')), 'A') ||
                 setweight(to_tsvector('english', coalesce(subject,  '')), 'B') ||
                 setweight(to_tsvector('english', coalesce(keywords, '')), 'B') ||
                 setweight(to_tsvector('english', coalesce(detail,   '')), 'C')
               ) stored,

  -- A record cannot supersede itself. Cheap to state, confusing to debug if it
  -- ever happens, because the "current" view would silently drop the row.
  constraint work_records_no_self_supersede check (supersedes is null or supersedes <> id),

  -- If it is blocked, say on what. A blocked record with no reason is the one
  -- thing in here that is actively worse than no record.
  constraint work_records_blocked_has_reason
    check (status <> 'blocked' or blocked_on is not null or needs_from is not null)
);

-- Derives the two columns the caller should not have to supply: keywords,
-- because a generated column cannot call array_to_string, and team, because
-- asking every write path to remember it guarantees some of them will not.
create function public.work_records_derive() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.keywords := array_to_string(coalesce(new.tags, '{}'), ' ');

  -- Stamped once, on insert only. An update must not re-derive it: the whole
  -- point of the column is that it records the team as it was at the time, so
  -- re-reading people.team later would undo exactly what it exists to prevent.
  -- An explicitly supplied team is honoured, for backfills and imports.
  if tg_op = 'INSERT' and new.team is null then
    select p.team into new.team from public.people p where p.id = new.person_id;
  end if;

  return new;
end;
$$;

create trigger work_records_derive_biu
  before insert or update of tags on public.work_records
  for each row execute function public.work_records_derive();

-- ---------------------------------------------------------------------------
-- indexes — one per question in SCHEMA.md's list, and no more
-- ---------------------------------------------------------------------------

-- "What has this person done lately?"
create index work_records_person_time_idx
  on public.work_records (person_id, occurred_at desc);

-- "What changed since I last looked?" — the polling query, run by every agent
-- on every check, and therefore the most expensive omission possible. It was
-- missing from the first draft because the index list was built from the shape
-- of the record instead of from the questions the record has to answer.
-- Compound with id because the cursor is (recorded_at, id): an agent recording
-- a burst writes several rows in the same instant.
create index work_records_recorded_idx
  on public.work_records (recorded_at, id);

-- "What have we decided lately?", with no subject and no search terms.
-- Decisions are the highest-value rows in here and the ones people browse
-- deliberately rather than search for.
create index work_records_kind_time_idx
  on public.work_records (kind, occurred_at desc);

-- "What is my team doing?" — more useful than the per-person view for almost
-- everyone except the person themselves.
create index work_records_team_time_idx
  on public.work_records (team, occurred_at desc)
  where team is not null;

-- "What is happening on this subject, in order?"
create index work_records_subject_time_idx
  on public.work_records (subject, occurred_at);

-- "What is blocked right now?" Partial, because the answer is always a tiny
-- fraction of the table and stays small as it grows.
create index work_records_open_idx
  on public.work_records (status, occurred_at desc)
  where status in ('open', 'blocked');

-- "Who is waiting on me?"
create index work_records_needs_from_idx
  on public.work_records (needs_from)
  where needs_from is not null;

-- Supersession is followed backwards by the current_work view.
create index work_records_supersedes_idx
  on public.work_records (supersedes)
  where supersedes is not null;

create index work_records_search_idx on public.work_records using gin (search);
create index work_records_tags_idx   on public.work_records using gin (tags);

-- ---------------------------------------------------------------------------
-- current_work — everything nothing else has replaced
--
-- A view rather than a column, so "is this still true" cannot drift out of step
-- with the supersedes chain. History stays intact: nothing is deleted, so
-- "what did we think in August" is still answerable by querying the table.
-- ---------------------------------------------------------------------------
-- security_invoker is NOT optional here. A view runs as its owner by default,
-- which means it reads straight past the row-level security below and hands
-- every private record to anyone who selects from it. The RLS would look
-- correct, the table would be locked down, and the leak would be through the
-- convenience view nobody re-checked.
create view public.current_work with (security_invoker = true) as
  select r.*
  from public.work_records r
  where not exists (
    select 1 from public.work_records s where s.supersedes = r.id
  );

-- ---------------------------------------------------------------------------
-- visibility
--
-- RLS rather than filtering in the application, because there will eventually
-- be more than one way in — the MCP, the web view, an export — and a rule
-- enforced in three places is a rule enforced in two.
--
-- These assume Supabase Auth with a verified email claim, and a people row
-- whose email matches. They are the shape, not the finished article: a real
-- deployment needs the team lookup to be a real join, not a subquery per row.
-- ---------------------------------------------------------------------------
alter table public.work_records enable row level security;

create function public.current_person_id() returns text
language sql stable security definer set search_path = public as $$
  select id from public.people
  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1;
$$;

-- Takes no argument on purpose. An earlier version was team_of(person_id),
-- which the policy needs granted to `authenticated` — and that would also have
-- handed every signed-in user a way to look up anybody else's team. This can
-- only ever answer for the caller.
create function public.my_team() returns text
language sql stable security definer set search_path = public as $$
  select p.team from public.people p
  where lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  limit 1;
$$;

-- Now that the record carries its own team, this compares a column to one
-- function call instead of a lookup per row. It is also more correct: a record
-- stays visible to the team it was written in, rather than moving with its
-- author when they change teams.
create policy work_records_read on public.work_records
  for select to authenticated
  using (
    visibility = 'company'
    or person_id = public.current_person_id()
    or (
      visibility = 'team'
      and team is not null
      and team is not distinct from public.my_team()
    )
  );

-- You may only write your own. Same rule as the skills hub, and the same
-- reason: ownership compares an id the caller does not choose, so there is no
-- way to phrase the request that gets around it.
create policy work_records_write on public.work_records
  for insert to authenticated
  with check (person_id = public.current_person_id());

create policy work_records_update on public.work_records
  for update to authenticated
  using (person_id = public.current_person_id())
  with check (person_id = public.current_person_id());

-- ---------------------------------------------------------------------------
-- Postgres grants EXECUTE to PUBLIC on every new function, and Supabase ALSO
-- grants to anon and authenticated BY NAME through default privileges. Revoking
-- from PUBLIC alone is correct on stock Postgres and insufficient here. This
-- exact gap left two write functions reachable by anon in the skills schema,
-- and the database linter did not catch it.
--
-- Check with:
--   select proname, array_to_string(proacl::text[], ' | ')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public';
-- ---------------------------------------------------------------------------
-- These two MUST stay executable by `authenticated`, and that is not an
-- oversight. An RLS policy expression is evaluated as the querying role, so a
-- policy calling a SECURITY DEFINER helper still needs that role to hold
-- EXECUTE on it. Revoking from `authenticated` does not tighten the policy, it
-- breaks it: every signed-in user gets "permission denied for function
-- current_person_id" on every select, which reads as a broken app rather than a
-- misapplied grant. Both take no argument and answer only about the caller,
-- derived from the caller's own verified JWT claim, so there is nothing to
-- probe with.
grant execute on function public.current_person_id() to authenticated;
grant execute on function public.my_team()           to authenticated;

revoke execute on function public.current_person_id() from public, anon;
revoke execute on function public.my_team()           from public, anon;
revoke execute on function public.work_records_derive() from public, anon, authenticated;

-- RLS restricts which rows a role sees. It does not grant access to the table
-- in the first place, so without these the policies have nothing to filter.
grant select, insert, update on public.work_records to authenticated;
grant select on public.current_work to authenticated;
revoke all on public.work_records from anon;

-- Supabase grants SELECT on new views to anon by default, so this one arrived
-- reachable. security_invoker already made it harmless — tested, anon was
-- refused at work_records underneath — but a view that anon can name is one
-- security_invoker slip away from being a leak, and revoking is free.
revoke all on public.current_work from anon;

alter default privileges in schema public
  revoke execute on functions from public, anon;
