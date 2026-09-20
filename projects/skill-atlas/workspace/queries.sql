-- The six questions from SCHEMA.md, written out.
--
-- These are the test of the schema, not a convenience library. If one of them
-- is awkward to express, the record is shaped wrong and the schema should
-- change rather than the query getting cleverer.
--
-- Draft 1, 11 August 2026. The shapes below were exercised through the
-- functions in functions.sql against project overmssglaikxnwtfvoc, on seeded
-- data covering three people across two teams and all three visibility levels.
-- The planner behaviour claimed in the comments is still reasoned rather than
-- measured — run `explain analyze` on real volume before believing that part.
--
-- Three findings came out of writing these. They are recorded at the bottom.

-- ---------------------------------------------------------------------------
-- 1. What has this person done in the last week?
--
-- Reads from current_work, not work_records: if someone recorded "blocked on
-- the export" on Tuesday and "shipped the export" on Thursday, only Thursday
-- is true now. The Tuesday row is still in the table for history.
-- ---------------------------------------------------------------------------
select occurred_at, kind, summary, subject, status
from   public.current_work
where  person_id = $1
  and  occurred_at >= now() - interval '7 days'
order  by occurred_at desc;

-- ---------------------------------------------------------------------------
-- 2. What is happening on this subject, in order?
--
-- Ascending, because a thread is read forwards. This is the query that decides
-- whether `subject` is doing its job: if it returns three records when the
-- person expected ten, subjects have sprawled and the slug constraint is not
-- enough on its own.
-- ---------------------------------------------------------------------------
select occurred_at, person_id, agent, kind, summary, status, artifacts
from   public.current_work
where  subject = $1
order  by occurred_at asc;

-- ---------------------------------------------------------------------------
-- 3. What is blocked right now, and who is it waiting on?
--
-- The one an agent should run unprompted before asking "what should I do".
-- Oldest first: the thing stuck longest is the thing worth interrupting for.
-- ---------------------------------------------------------------------------
select r.subject,
       r.summary,
       r.blocked_on,
       r.needs_from,
       p.display_name           as waiting_on_name,
       r.occurred_at,
       now() - r.occurred_at    as stuck_for
from   public.current_work r
left   join public.people p on p.id = r.needs_from
where  r.status = 'blocked'
order  by r.occurred_at asc;

-- ---------------------------------------------------------------------------
-- 4. What did we decide about X, and why?
--
-- Two ways in, because the person asking usually does not know the subject
-- slug. An exact subject match if they have it, full text if they only have
-- the words. `detail` carries the reasoning, which is the whole point of the
-- `decided` kind — a decision without its reason has to be re-litigated.
-- ---------------------------------------------------------------------------
select occurred_at, person_id, subject, summary, detail, confidence
from   public.current_work
where  kind = 'decided'
  and  (subject = $1 or search @@ websearch_to_tsquery('english', $1))
order  by occurred_at desc;

-- ---------------------------------------------------------------------------
-- 5. Who has touched anything like this before?
--
-- "Who should I ask." Ranked by recency of last contact rather than volume,
-- because the person who did it once last week remembers it better than the
-- person who did it ten times last year.
-- ---------------------------------------------------------------------------
select r.person_id,
       p.display_name,
       count(*)                              as records,
       max(r.occurred_at)                    as last_touched,
       array_agg(distinct r.subject)         as subjects
from   public.current_work r
join   public.people p on p.id = r.person_id
where  r.search @@ websearch_to_tsquery('english', $1)
group  by r.person_id, p.display_name
order  by max(r.occurred_at) desc
limit  10;

-- ---------------------------------------------------------------------------
-- 6. What changed since I last looked?
--
-- The polling query, and the one an agent runs most often — so it is the one
-- whose cost matters most.
--
-- Ordered by recorded_at, not occurred_at: someone writing up last Tuesday's
-- work today is new to me even though it happened a week ago. Filtering on
-- occurred_at would silently skip it forever.
--
-- The cursor is (recorded_at, id), not recorded_at alone. Two records written
-- in the same instant are common when an agent records a burst of work, and a
-- timestamp-only cursor either repeats them or drops them.
-- ---------------------------------------------------------------------------
select recorded_at, id, occurred_at, person_id, kind, summary, subject, status
from   public.current_work
where  (recorded_at, id) > ($1, $2)
order  by recorded_at, id
limit  200;

-- ===========================================================================
-- What writing these revealed — all three applied to schema.sql on 11 Aug
-- ===========================================================================
--
-- FINDING 1 — recorded_at had no index, and query 6 needs one.
--
-- The index list was built from the shape of the record rather than from the
-- questions, so it covered person, subject, status and search, and missed the
-- single most frequently run query in the system. Query 6 was a sequential
-- scan of the whole table on every poll by every agent — the kind of thing
-- that looks fine in testing and falls over at thirty users.
-- Fixed: work_records_recorded_idx (recorded_at, id).
--
-- FINDING 2 — query 4 had no index for the `kind` filter.
--
-- "All decisions recently", with no subject and no search terms, filtered on
-- kind alone and scanned.
-- Fixed: work_records_kind_time_idx (kind, occurred_at desc).
--
-- FINDING 3 — team was not on the record.
--
-- Not only a performance problem. People change teams, and a record is a
-- historical fact: reading team live from people meant moving one person
-- silently rewrote the history of who did what for whom.
-- Fixed: a `team` column stamped on insert by work_records_derive(), plus
-- work_records_team_time_idx. It also let the visibility policy compare a
-- column instead of calling team_of once per row.
--
-- None of the three changed the record's shape or its vocabulary, which is the
-- part that would have been expensive to get wrong. All six questions are
-- expressible, none needed a join the schema did not anticipate, and none
-- needed a field missing from the write path. On that evidence the shape
-- holds; the indexes were guessed and the guesses were wrong, which is the
-- cheap half to fix.
--
-- Two further bugs were found only by running the schema, not by reading it:
-- the current_work view bypassed RLS without security_invoker, and can_see let
-- an unrecognised viewer read every company-visibility record. Both are noted
-- where they live. Reading SQL carefully catches maybe half of what executing
-- it does.
