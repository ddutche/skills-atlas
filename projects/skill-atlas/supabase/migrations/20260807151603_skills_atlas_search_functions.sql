-- The queries the atlas, the MCP and the Lucid exporter all go through, kept in
-- the database so the three cannot disagree about what a search means.

create or replace function public.search_skills(
  q text, disciplines text[] default null,
  author_id text default null, max_results int default 20
)
returns table (
  author text, id text, name text, description text, discipline text,
  kind text, person text, team text, installs bigint, rank real
)
language sql stable security definer
set search_path = public, extensions
as $$
  with matched as (
    select s.*,
           case when coalesce(q,'') = '' then 0::real
                else ts_rank(s.search, websearch_to_tsquery('english', q)) end as ts,
           case when coalesce(q,'') = '' then 0::real
                else similarity(s.name, q) end as trg
    from public.skills s
    where (disciplines is null or s.discipline = any(disciplines))
      and (author_id is null or s.author = author_id)
      -- trigram fallback covers the half-typed case: "questionn" is not a word,
      -- so to_tsquery has nothing to match, but the person clearly wants
      -- security-questionnaire.
      and (coalesce(q,'') = ''
           or s.search @@ websearch_to_tsquery('english', q)
           or s.name % q)
  )
  select m.author, m.id, m.name, m.description, m.discipline, m.kind,
         p.display_name, p.team,
         (select count(*) from public.skill_installs i
           where i.skill_author = m.author and i.skill_id = m.id),
         greatest(m.ts, m.trg)
  from matched m join public.people p on p.id = m.author
  order by greatest(m.ts, m.trg) desc, m.name
  limit greatest(1, least(max_results, 100));
$$;

create or replace function public.get_skill(author_id text, skill_id text)
returns table (
  author text, id text, name text, description text, discipline text,
  kind text, source text, url text, why text, updated date,
  about_html text, body text, mmd text, person text, team text, installs bigint
)
language sql stable security definer set search_path = public
as $$
  select s.author, s.id, s.name, s.description, s.discipline, s.kind,
         s.source, s.url, s.why, s.updated, s.about_html, s.body, s.mmd,
         p.display_name, p.team,
         (select count(*) from public.skill_installs i
           where i.skill_author = s.author and i.skill_id = s.id)
  from public.skills s join public.people p on p.id = s.author
  where s.author = author_id and s.id = skill_id;
$$;

-- One call in place of one Drive read per file. body and about_html are left
-- out because they were 57% of the page and are only read on open.
create or replace function public.get_atlas()
returns jsonb language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'people', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name,
             'role', p.team, 'dept', p.team) order by p.display_name)
      from public.people p
      where exists (select 1 from public.skills s where s.author = p.id)), '[]'::jsonb),
    'skills', coalesce((
      select jsonb_agg(jsonb_build_object(
        'author', s.author, 'id', s.id, 'name', s.name, 'desc', s.description,
        'discipline', s.discipline, 'kind', s.kind, 'source', s.source,
        'url', s.url, 'why', s.why, 'updated', s.updated,
        'tags', s.tags, 'auto', s.auto_tags, 'mmd', s.mmd,
        'installs', (select count(*) from public.skill_installs i
                      where i.skill_author = s.author and i.skill_id = s.id)
      ) order by s.name) from public.skills s), '[]'::jsonb),
    'settings', coalesce((select jsonb_object_agg(key, value) from public.settings), '{}'::jsonb)
  );
$$;
