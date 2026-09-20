# Supabase: the queryable index

This database is **not** the source of truth. Every row in `people` and `skills`
is derived from a file in the Shared Drive and can be rebuilt from it in one
run. That is the whole point of the design: if this project is paused, deleted,
or its ownership handoff decays, the hub keeps serving from Drive and anyone can
rebuild the index from scratch.

The one exception is `skill_installs`, which records who has taken what. Nothing
in Drive holds that, so it is the one table worth preserving across a rebuild.

## Why it exists

The Drive-only version reads every file in the hub to build its index. Measured:

| | 100 skills | 500 | 1000 |
|---|---|---|---|
| Drive round trips | ~350 | 1,746 | 3,506 |
| Cold build | 21 to 42s | 105 to 210s | **210 to 421s** |
| Served page | 145KB | 731KB | 1,361KB |
| Search, per keystroke | 16ms | 138ms | 413ms |

Apps Script kills any execution at six minutes, so the cold build starts failing
somewhere around a thousand skills. Against Postgres the same search is a single
indexed query: **7ms**, measured on this project.

## Files

- `migrations/` applied in filename order. Run them against a fresh project to
  reproduce this database exactly.

## Access

Nothing here is reachable without the service role. RLS is on with no policies,
table grants are revoked from `anon` and `authenticated`, and the three query
functions had their EXECUTE revoked from `PUBLIC`.

That last one is worth knowing about if you add a function later. Postgres
grants EXECUTE to `PUBLIC` on every new function, and `anon` inherits from
`PUBLIC`, so revoking from `anon` by name does nothing. `alter default
privileges in schema public revoke execute on functions from public` is set, so
new functions are closed by default, but check with:

```sql
select proname, proacl from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';
```

An ACL of `postgres=X/postgres | service_role=X/postgres` is right. Anything
mentioning `=X/` with no role in front means PUBLIC can call it.

## Callers

Apps Script and the Edge Function, both holding the service role key. Neither
the atlas page nor anybody's browser talks to Postgres directly, which is why
there is no anon path to secure.
