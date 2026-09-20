-- The five work functions behind the MCP tools in tools.ts.
--
-- Applied and tested against project overmssglaikxnwtfvoc on 11 August 2026.
--
-- ---------------------------------------------------------------------------
-- Why every one of these takes p_viewer
--
-- The Edge Function calls these with the service role key, which bypasses RLS
-- entirely. So the row-level policies on work_records protect the PostgREST and
-- web paths, and do nothing at all here. These functions have to enforce
-- visibility themselves, against the person the caller claims to be.
--
-- That is the single most dangerous thing about this file. A missing can_see()
-- in one function leaks every private record through that one tool, and the
-- table's RLS will look perfectly correct while it happens. Hence one shared
-- predicate rather than the condition written out five times.
-- ---------------------------------------------------------------------------

-- One definition of "may this person see this record". Used by all four reads.
--
-- The exists() check is not redundant. Without it an unrecognised viewer still
-- matched the company branch, so a mistyped or spoofed X-Hub-User header read
-- the entire company feed. Identity here is asserted by the Edge Function
-- rather than proven, so this does not stop someone who knows a colleague's id
-- — it stops someone who does not. Found by calling find_work('mallory'),
-- not by reading the predicate.
create or replace function public.can_see(
  p_visibility work_visibility, p_owner text, p_team text, p_viewer text
) returns boolean
language sql stable security definer set search_path = public as $$
  select p_viewer is not null
     and exists (select 1 from public.people where id = p_viewer)
     and (
          p_visibility = 'company'
       or p_owner = p_viewer
       or (p_visibility = 'team'
           and p_team is not null
           and p_team is not distinct from (select team from public.people where id = p_viewer))
     );
$$;

-- Accepts an ISO timestamp or an interval phrase like '7 days', because the
-- model will produce either and rejecting one of them is a worse experience
-- than handling both.
create or replace function public.parse_since(p text)
returns timestamptz language plpgsql immutable as $$
begin
  if p is null or p = '' then return null; end if;
  begin return p::timestamptz; exception when others then end;
  begin return now() - p::interval; exception when others then end;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. record_work — the write path
--
-- Returns similar_subjects on every write. The agent picked a subject blind,
-- and the cheapest correction is telling it what already existed immediately
-- after it guessed. SCHEMA.md names subject sprawl as the failure that makes
-- the workspace unqueryable while still looking fine; this is the counter.
-- ---------------------------------------------------------------------------
create or replace function public.record_work(
  p_person      text,
  p_kind        work_kind,
  p_summary     text,
  p_subject     text,
  p_confidence  work_confidence,
  p_detail      text            default null,
  p_artifacts   jsonb           default '[]',
  p_status      work_status     default 'done',
  p_blocked_on  text            default null,
  p_needs_from  text            default null,
  p_supersedes  uuid            default null,
  p_visibility  work_visibility default 'team',
  p_occurred_at timestamptz     default null,
  p_tags        text[]          default '{}',
  p_agent       text            default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  new_id uuid;
  -- Not named `similar`: SIMILAR is reserved in Postgres (SIMILAR TO) and a
  -- plpgsql variable of that name is a syntax error several lines away from
  -- where it reads like the problem is.
  close_subjects text[];
begin
  if not exists (select 1 from public.people where id = p_person) then
    return jsonb_build_object('ok', false,
      'message', 'No such person. Publish a skill or be added to the hub first.');
  end if;

  -- Checked here as well as by the table constraint so the caller gets a
  -- sentence it can act on instead of a constraint violation.
  if p_subject !~ '^[a-z0-9][a-z0-9-]{0,79}$' then
    return jsonb_build_object('ok', false,
      'message', 'Subject must be a lowercase slug: letters, numbers and hyphens, e.g. acme-integration.');
  end if;

  if p_status = 'blocked' and p_blocked_on is null and p_needs_from is null then
    return jsonb_build_object('ok', false,
      'message', 'A blocked record needs blocked_on or needs_from. A blocker nobody named is not actionable.');
  end if;

  insert into public.work_records (
    person_id, agent, kind, summary, detail, subject, artifacts,
    status, blocked_on, needs_from, supersedes, confidence, visibility, tags,
    occurred_at
  ) values (
    p_person, p_agent, p_kind, p_summary, p_detail, p_subject,
    coalesce(p_artifacts, '[]'::jsonb),
    p_status, p_blocked_on, p_needs_from, p_supersedes, p_confidence,
    p_visibility, coalesce(p_tags, '{}'),
    coalesce(p_occurred_at, now())
  ) returning id into new_id;

  select array_agg(s order by sim desc) into close_subjects from (
    select w.subject as s, max(similarity(w.subject, p_subject)) as sim
    from public.work_records w
    where w.subject <> p_subject
      and similarity(w.subject, p_subject) > 0.3
    group by w.subject
    order by sim desc
    limit 5
  ) t;

  return jsonb_build_object(
    'ok', true,
    'id', new_id,
    'subject_used', p_subject,
    'similar_subjects', coalesce(close_subjects, '{}'),
    'note', case when close_subjects is null then null else
      'Subjects that already exist and look close. If one of them is the same thread, use it next time.' end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. find_work — the general read
--
-- Ascending when a single subject is named, because a thread is read forwards.
-- Descending otherwise, because a feed is read backwards. That is a real
-- difference in what the caller is asking for, not a preference.
-- ---------------------------------------------------------------------------
create or replace function public.find_work(
  p_viewer  text,
  p_query   text        default null,
  p_subject text        default null,
  p_person  text        default null,
  p_team    text        default null,
  p_kind    work_kind   default null,
  p_status  work_status default null,
  p_since   text        default null,
  p_limit   int         default 30
) returns table (
  id uuid, occurred_at timestamptz, person_id text, person text, team text,
  agent text, kind work_kind, summary text, detail text, subject text,
  artifacts jsonb, status work_status, blocked_on text, needs_from text,
  confidence work_confidence, visibility work_visibility, tags text[]
)
language sql stable security definer set search_path = public, extensions as $$
  select r.id, r.occurred_at, r.person_id, p.display_name, r.team,
         r.agent, r.kind, r.summary, r.detail, r.subject,
         r.artifacts, r.status, r.blocked_on, r.needs_from,
         r.confidence, r.visibility, r.tags
  from public.current_work r
  join public.people p on p.id = r.person_id
  where public.can_see(r.visibility, r.person_id, r.team, p_viewer)
    and (p_subject is null or r.subject = p_subject)
    and (p_person  is null or r.person_id = p_person)
    and (p_team    is null or r.team = p_team)
    and (p_kind    is null or r.kind = p_kind)
    and (p_status  is null or r.status = p_status)
    and (public.parse_since(p_since) is null or r.occurred_at >= public.parse_since(p_since))
    and (coalesce(p_query,'') = '' or r.search @@ websearch_to_tsquery('english', p_query))
  order by
    case when p_subject is not null then r.occurred_at end asc,
    case when p_subject is null     then r.occurred_at end desc
  limit greatest(1, least(coalesce(p_limit, 30), 200));
$$;

-- ---------------------------------------------------------------------------
-- 3. whats_blocked
--
-- Oldest first. The thing stuck longest is worth more attention than the thing
-- stuck most recently, and sorting the other way buries it.
-- ---------------------------------------------------------------------------
create or replace function public.whats_blocked(
  p_viewer     text,
  p_waiting_on text default null,
  p_team       text default null,
  p_limit      int  default 30
) returns table (
  id uuid, occurred_at timestamptz, stuck_for interval,
  person_id text, person text, team text, subject text, summary text,
  blocked_on text, needs_from text, waiting_on_name text
)
language sql stable security definer set search_path = public as $$
  select r.id, r.occurred_at, now() - r.occurred_at,
         r.person_id, p.display_name, r.team, r.subject, r.summary,
         r.blocked_on, r.needs_from, w.display_name
  from public.current_work r
  join public.people p on p.id = r.person_id
  left join public.people w on w.id = r.needs_from
  where r.status = 'blocked'
    and public.can_see(r.visibility, r.person_id, r.team, p_viewer)
    and (p_waiting_on is null or r.needs_from = p_waiting_on)
    and (p_team is null or r.team = p_team)
  order by r.occurred_at asc
  limit greatest(1, least(coalesce(p_limit, 30), 200));
$$;

-- ---------------------------------------------------------------------------
-- 4. who_worked_on
--
-- Returns people, not records. Ranked by recency of last contact rather than
-- volume: someone who did it once last week remembers it better than someone
-- who did it ten times last year.
-- ---------------------------------------------------------------------------
create or replace function public.who_worked_on(
  p_viewer text,
  p_query  text,
  p_limit  int default 10
) returns table (
  person_id text, person text, team text,
  records bigint, last_touched timestamptz, subjects text[]
)
language sql stable security definer set search_path = public as $$
  select r.person_id, p.display_name, max(r.team),
         count(*), max(r.occurred_at),
         (array_agg(distinct r.subject))[1:5]
  from public.current_work r
  join public.people p on p.id = r.person_id
  where public.can_see(r.visibility, r.person_id, r.team, p_viewer)
    and coalesce(p_query,'') <> ''
    and r.search @@ websearch_to_tsquery('english', p_query)
  group by r.person_id, p.display_name
  order by max(r.occurred_at) desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

-- ---------------------------------------------------------------------------
-- 5. catch_up
--
-- Ordered by recorded_at, not occurred_at: a colleague writing up last week's
-- work today is new to me even though it happened a week ago, and filtering on
-- occurred_at would skip it forever.
--
-- The cursor is (recorded_at, id) because an agent recording a burst writes
-- several rows in the same instant, and a timestamp-only cursor either repeats
-- them or drops them. Returned as jsonb so the cursor travels with the rows
-- instead of the caller having to reconstruct it from the last row.
-- ---------------------------------------------------------------------------
create or replace function public.catch_up(
  p_viewer text,
  p_cursor text default null,
  p_team   text default null,
  p_limit  int  default 100
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c_time timestamptz;
  c_id   uuid;
  page_rows jsonb;
  last_t timestamptz;
  last_i uuid;
  n      int;
begin
  if p_cursor is null or p_cursor = '' then
    c_time := now() - interval '24 hours';
    c_id   := '00000000-0000-0000-0000-000000000000';
  else
    c_time := split_part(p_cursor, '|', 1)::timestamptz;
    c_id   := split_part(p_cursor, '|', 2)::uuid;
  end if;

  -- One pass. The last row's (recorded_at, id) is taken with array_agg rather
  -- than by running the page query a second time ordered backwards — the naive
  -- version doubles the cost of the most frequently called function here.
  with page as (
    select r.id, r.recorded_at, r.occurred_at, r.person_id, p.display_name as person,
           r.team, r.agent, r.kind, r.summary, r.subject, r.status, r.artifacts
    from public.current_work r
    join public.people p on p.id = r.person_id
    where public.can_see(r.visibility, r.person_id, r.team, p_viewer)
      and (p_team is null or r.team = p_team)
      and (r.recorded_at, r.id) > (c_time, c_id)
    order by r.recorded_at, r.id
    limit greatest(1, least(coalesce(p_limit, 100), 200))
  )
  select jsonb_agg(to_jsonb(page) order by page.recorded_at, page.id),
         count(*),
         (array_agg(page.recorded_at order by page.recorded_at desc, page.id desc))[1],
         (array_agg(page.id          order by page.recorded_at desc, page.id desc))[1]
  into page_rows, n, last_t, last_i
  from page;

  return jsonb_build_object(
    'count', coalesce(n, 0),
    'records', coalesce(page_rows, '[]'::jsonb),
    -- Unchanged when there was nothing new, so an idle poll does not advance
    -- past records that arrive a moment later with an earlier recorded_at.
    'cursor', case when coalesce(n, 0) > 0 then last_t::text || '|' || last_i::text
                   else coalesce(nullif(p_cursor, ''), c_time::text || '|' || c_id::text) end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Same trap as everywhere else in this project: Supabase grants EXECUTE
-- on new functions to anon and authenticated BY NAME, so a PUBLIC-only revoke
-- leaves them reachable. These take p_viewer as an argument, so anyone who
-- could call them directly could pass anybody's id and read their private
-- records — service_role only, and identity is asserted by the Edge Function.
-- ---------------------------------------------------------------------------
revoke execute on function public.record_work(text, work_kind, text, text, work_confidence, text, jsonb, work_status, text, text, uuid, work_visibility, timestamptz, text[], text) from public, anon, authenticated;
revoke execute on function public.find_work(text, text, text, text, text, work_kind, work_status, text, int) from public, anon, authenticated;
revoke execute on function public.whats_blocked(text, text, text, int) from public, anon, authenticated;
revoke execute on function public.who_worked_on(text, text, int) from public, anon, authenticated;
revoke execute on function public.catch_up(text, text, text, int) from public, anon, authenticated;
revoke execute on function public.can_see(work_visibility, text, text, text) from public, anon, authenticated;
revoke execute on function public.parse_since(text) from public, anon, authenticated;

grant execute on function public.record_work(text, work_kind, text, text, work_confidence, text, jsonb, work_status, text, text, uuid, work_visibility, timestamptz, text[], text) to service_role;
grant execute on function public.find_work(text, text, text, text, text, work_kind, work_status, text, int) to service_role;
grant execute on function public.whats_blocked(text, text, text, int) to service_role;
grant execute on function public.who_worked_on(text, text, int) to service_role;
grant execute on function public.catch_up(text, text, text, int) to service_role;
