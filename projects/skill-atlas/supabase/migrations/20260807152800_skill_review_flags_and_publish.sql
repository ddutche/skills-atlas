-- Applied to project tngqezghhkggazuvdeev on 2026-08-07.

alter table public.skills add column flags text[] not null default '{}';
create index skills_flagged_idx on public.skills (author, id) where cardinality(flags) > 0;

comment on column public.skills.flags is
  'Advisory. A credential blocks a publish outright; everything else is flagged and let through, because a skill about secrets safety legitimately discusses API keys and a scanner that blocks it will be switched off.';

create or replace function public.publish_skill(
  p_author text, p_display_name text, p_email text, p_team text,
  p_id text, p_name text, p_description text, p_discipline text, p_kind text,
  p_body text, p_about_html text default null, p_mmd text default null,
  p_tags text[] default '{}', p_auto_tags text[] default '{}',
  p_flags text[] default '{}'
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare existed boolean;
begin
  insert into public.people (id, display_name, email, team, updated_at, synced_at)
  values (p_author, coalesce(p_display_name, p_author), p_email, p_team, current_date, now())
  on conflict (id) do update
    set display_name = coalesce(excluded.display_name, people.display_name),
        email        = coalesce(excluded.email, people.email),
        team         = coalesce(excluded.team, people.team),
        updated_at   = current_date, synced_at = now();

  select true into existed from public.skills where author = p_author and id = p_id;

  insert into public.skills (
    author, id, name, description, discipline, kind, body, about_html, mmd,
    tags, auto_tags, keywords, flags, updated, synced_at
  ) values (
    p_author, p_id, p_name, p_description, p_discipline, p_kind, p_body,
    p_about_html, p_mmd, coalesce(p_tags,'{}'), coalesce(p_auto_tags,'{}'),
    array_to_string(coalesce(p_tags,'{}') || coalesce(p_auto_tags,'{}'), ' '),
    coalesce(p_flags,'{}'), current_date, now()
  )
  on conflict (author, id) do update
    set name = excluded.name, description = excluded.description,
        discipline = excluded.discipline, kind = excluded.kind,
        body = excluded.body, about_html = excluded.about_html, mmd = excluded.mmd,
        tags = excluded.tags, auto_tags = excluded.auto_tags,
        keywords = excluded.keywords, flags = excluded.flags,
        updated = current_date, synced_at = now();

  return jsonb_build_object('ok', true, 'key', p_author || '/' || p_id,
                            'replaced', coalesce(existed, false),
                            'flags', coalesce(p_flags, '{}'));
end;
$$;

create or replace function public.record_install(p_person text, p_author text, p_id text)
returns jsonb language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.people where id = p_person) then
    return jsonb_build_object('ok', false, 'message', 'No such person in the hub yet.');
  end if;
  insert into public.skill_installs (person_id, skill_author, skill_id)
  values (p_person, p_author, p_id) on conflict do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

-- PUBLIC gets EXECUTE on every new function and anon inherits from PUBLIC, so
-- revoking from anon by name would do nothing. See the other grants migration.
revoke execute on function public.publish_skill(text,text,text,text,text,text,text,text,text,text,text,text,text[],text[],text[]) from public;
revoke execute on function public.record_install(text,text,text) from public;
grant execute on function public.publish_skill(text,text,text,text,text,text,text,text,text,text,text,text,text[],text[],text[]) to service_role;
grant execute on function public.record_install(text,text,text) to service_role;
