-- Postgres grants EXECUTE to PUBLIC on every newly created function, and anon
-- and authenticated both inherit from PUBLIC. Revoking from those two roles by
-- name does NOTHING: the grant they actually use is the PUBLIC one.
--
-- Without this, all three SECURITY DEFINER functions were callable at
-- /rest/v1/rpc/<name> by anyone holding the publishable key, which handed over
-- the entire index and made the RLS lockdown decorative.

revoke execute on function public.get_atlas()                            from public;
revoke execute on function public.get_skill(text, text)                  from public;
revoke execute on function public.search_skills(text, text[], text, int) from public;

grant execute on function public.get_atlas()                             to service_role;
grant execute on function public.get_skill(text, text)                   to service_role;
grant execute on function public.search_skills(text, text[], text, int)  to service_role;

revoke all on public.people         from anon, authenticated;
revoke all on public.skills         from anon, authenticated;
revoke all on public.skill_installs from anon, authenticated;
revoke all on public.settings       from anon, authenticated;

-- So a function added later is closed by default rather than open by default.
alter default privileges in schema public revoke execute on functions from public;
