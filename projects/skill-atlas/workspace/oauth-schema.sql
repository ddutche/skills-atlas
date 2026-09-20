-- OAuth state for the Cloudflare Worker gateway.
--
-- The Worker is the authorization server Claude talks to. It holds no database
-- credentials: it calls the Edge Function, which already has the service key,
-- and the Edge Function calls these. That keeps the original rule intact —
-- the service role key never leaves Supabase.
--
-- Only two things need storing. Access tokens do NOT: they are HMAC-signed
-- JWTs the Worker verifies itself, so the hot path (every MCP call) costs no
-- database round trip at all.
--
--   oauth_clients  Claude registers itself here, once, via RFC 7591.
--   oauth_codes    Authorization codes. Stored because single-use has to be
--                  enforced somewhere, and "somewhere" cannot be a signature.

create table if not exists public.oauth_clients (
  client_id           text primary key,
  -- Hashed, never stored raw. A public client (PKCE only, no secret) stores
  -- null here, which is what Claude uses.
  client_secret_hash  text,
  redirect_uris       text[] not null,
  client_name         text,
  created_at          timestamptz not null default now()
);

create table if not exists public.oauth_codes (
  -- The code itself is never stored, only its SHA-256. A database leak then
  -- yields nothing usable, and codes live about sixty seconds anyway.
  code_hash             text primary key,
  client_id             text not null references public.oauth_clients (client_id) on delete cascade,
  redirect_uri          text not null,
  code_challenge        text not null,
  code_challenge_method text not null default 'S256',
  email                 text not null,
  scope                 text,
  expires_at            timestamptz not null,
  used_at               timestamptz
);

create index if not exists oauth_codes_expiry_idx on public.oauth_codes (expires_at);

alter table public.oauth_clients enable row level security;
alter table public.oauth_codes   enable row level security;
revoke all on public.oauth_clients from anon, authenticated;
revoke all on public.oauth_codes   from anon, authenticated;

-- ---------------------------------------------------------------------------
-- RFC 7591 dynamic client registration.
--
-- Open registration, deliberately. The spec allows it, Claude relies on it to
-- connect without anyone copying a client id by hand, and a registered client
-- can do nothing on its own: it still has to send a real human through Google
-- before it gets a token. The thing worth protecting is the sign-in, not the
-- client record.
-- ---------------------------------------------------------------------------
create or replace function public.oauth_register_client(
  p_client_id text, p_secret_hash text, p_redirect_uris text[], p_name text
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_redirect_uris is null or cardinality(p_redirect_uris) = 0 then
    return jsonb_build_object('ok', false, 'message', 'At least one redirect_uri is required.');
  end if;

  insert into public.oauth_clients (client_id, client_secret_hash, redirect_uris, client_name)
  values (p_client_id, p_secret_hash, p_redirect_uris, p_name);

  return jsonb_build_object('ok', true, 'client_id', p_client_id);
end;
$$;

create or replace function public.oauth_get_client(p_client_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'client_id', c.client_id,
    'client_secret_hash', c.client_secret_hash,
    'redirect_uris', c.redirect_uris,
    'client_name', c.client_name
  )
  from public.oauth_clients c where c.client_id = p_client_id;
$$;

create or replace function public.oauth_store_code(
  p_code_hash text, p_client_id text, p_redirect_uri text,
  p_challenge text, p_method text, p_email text, p_scope text,
  p_ttl_seconds int default 60
) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  -- Opportunistic cleanup. Codes are tiny and short-lived, so a sweep on write
  -- is cheaper than a scheduled job and there is nothing to forget to set up.
  delete from public.oauth_codes where expires_at < now() - interval '1 hour';

  insert into public.oauth_codes (
    code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
    email, scope, expires_at
  ) values (
    p_code_hash, p_client_id, p_redirect_uri, p_challenge,
    coalesce(p_method, 'S256'), p_email, p_scope,
    now() + make_interval(secs => greatest(10, least(p_ttl_seconds, 600)))
  );
  return jsonb_build_object('ok', true);
end;
$$;

-- Single-use, enforced by the UPDATE itself rather than by a read-then-write.
-- Two simultaneous redemptions of one code cannot both win: the second finds
-- used_at already set and matches no row.
create or replace function public.oauth_consume_code(p_code_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  update public.oauth_codes
     set used_at = now()
   where code_hash = p_code_hash
     and used_at is null
     and expires_at > now()
  returning * into r;

  if not found then
    return jsonb_build_object('ok', false,
      'message', 'That authorization code is unknown, expired, or already used.');
  end if;

  return jsonb_build_object(
    'ok', true, 'client_id', r.client_id, 'redirect_uri', r.redirect_uri,
    'code_challenge', r.code_challenge, 'code_challenge_method', r.code_challenge_method,
    'email', r.email, 'scope', r.scope
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Someone signing in for the first time has no people row, and without one
-- record_work refuses them. So the sign-in creates it.
--
-- Never overwrites a display_name or team that already exists: the hub's own
-- data is better than whatever Google has, and a re-login should not undo an
-- edit someone made deliberately.
-- ---------------------------------------------------------------------------
create or replace function public.oauth_upsert_person(p_email text, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pid text;
begin
  pid := regexp_replace(lower(split_part(split_part(p_email, '@', 1), '+', 1)), '[^a-z0-9._-]', '', 'g');
  if pid = '' then
    return jsonb_build_object('ok', false, 'message', 'That address does not make a usable id.');
  end if;

  insert into public.people (id, display_name, email, updated_at, synced_at)
  values (pid, coalesce(nullif(p_name, ''), pid), lower(p_email), current_date, now())
  on conflict (id) do update
    set email = coalesce(public.people.email, excluded.email),
        synced_at = now();

  return jsonb_build_object('ok', true, 'person_id', pid);
end;
$$;

revoke execute on function public.oauth_register_client(text, text, text[], text) from public, anon, authenticated;
revoke execute on function public.oauth_get_client(text)                          from public, anon, authenticated;
revoke execute on function public.oauth_store_code(text, text, text, text, text, text, text, int) from public, anon, authenticated;
revoke execute on function public.oauth_consume_code(text)                        from public, anon, authenticated;
revoke execute on function public.oauth_upsert_person(text, text)                 from public, anon, authenticated;

grant execute on function public.oauth_register_client(text, text, text[], text) to service_role;
grant execute on function public.oauth_get_client(text)                          to service_role;
grant execute on function public.oauth_store_code(text, text, text, text, text, text, text, int) to service_role;
grant execute on function public.oauth_consume_code(text)                        to service_role;
grant execute on function public.oauth_upsert_person(text, text)                 to service_role;
