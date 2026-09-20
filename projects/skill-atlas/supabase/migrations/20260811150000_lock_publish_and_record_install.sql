-- Close the write path that is open to anon.
--
-- WHAT IS WRONG
--
-- Checked against the live database on 11 August 2026:
--
--   publish_skill   postgres=X | anon=X | authenticated=X | service_role=X
--   record_install  postgres=X | anon=X | authenticated=X | service_role=X
--   search_skills   postgres=X | service_role=X               <- correct
--   get_skill       postgres=X | service_role=X               <- correct
--   get_atlas       postgres=X | service_role=X               <- correct
--
-- The two read functions from the first lockdown are fine. The two WRITE
-- functions added afterwards are executable by anon, which means anyone holding
-- the project's publishable key can POST straight to
-- /rest/v1/rpc/publish_skill and write a row into the atlas.
--
-- That bypasses the Edge Function, and the Edge Function is where the
-- credential scanner lives. So the one check that stands between the hub and a
-- hostile skill can currently be walked around by not calling it. It also lets
-- the caller set p_author to anybody, because only the Edge Function derives
-- the author from a verified-ish header; the SQL function trusts its argument.
--
-- WHY THE EARLIER MIGRATION DID NOT CATCH IT
--
-- 20260807152800 in this folder ends with the correct revokes. It is not what
-- was applied: the live migration is version 20260807155603, a later edit that
-- lost them. So the file that looks right has never run.
--
-- And the revoke it contains would not have been enough on its own. The first
-- lockdown migration reasoned that anon inherits EXECUTE from PUBLIC, so
-- revoking from PUBLIC is what counts. That is true for a plain Postgres
-- install. It is not the whole story on Supabase, which ships ALTER DEFAULT
-- PRIVILEGES granting EXECUTE on new functions in public to anon and
-- authenticated BY NAME. The ACL above shows exactly that: `anon=X/postgres` is
-- a named grant, not an inherited PUBLIC one, which is why the PUBLIC-only
-- revoke left it standing.
--
-- Hence both halves below. Revoke from PUBLIC *and* from the two roles by name,
-- then fix the default so the next function added does not reopen this.

revoke execute on function public.publish_skill(
  text, text, text, text, text, text, text, text, text, text, text, text,
  text[], text[], text[]
) from public, anon, authenticated;

revoke execute on function public.record_install(text, text, text)
  from public, anon, authenticated;

grant execute on function public.publish_skill(
  text, text, text, text, text, text, text, text, text, text, text, text,
  text[], text[], text[]
) to service_role;

grant execute on function public.record_install(text, text, text)
  to service_role;

-- The recurrence guard. The first lockdown set this for PUBLIC only, which is
-- why two functions created 20 minutes later still came out reachable.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;

-- Verify after applying. Every row should read postgres + service_role only:
--
--   select p.proname, array_to_string(p.proacl::text[], ' | ') as acl
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' order by p.proname;
--
-- The advisor agreeing is not sufficient evidence on its own. Read proacl.
