-- Applied to project tngqezghhkggazuvdeev on 2026-08-07.
-- See ../README.md. This database is an index over the Drive, not a store.

create extension if not exists vector with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create table public.people (
  id            text primary key,
  display_name  text not null,
  email         text unique,
  team          text,
  updated_at    date,
  synced_at     timestamptz not null default now()
);

create table public.skills (
  author        text not null references public.people(id) on delete cascade,
  id            text not null,
  name          text not null,
  description   text,
  discipline    text,
  kind          text,
  source        text,
  url           text,
  why           text,
  captured      date,
  updated       date,
  about_html    text,
  body          text,
  mmd           text,
  tags          text[] not null default '{}',
  auto_tags     text[] not null default '{}',
  -- tags flattened to text. The generated column below cannot call
  -- array_to_string: that function is only STABLE and a generated expression
  -- must be IMMUTABLE.
  keywords      text default '',
  synced_at     timestamptz not null default now(),
  primary key (author, id)
);

alter table public.skills
  add column search tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(keywords, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'D')
  ) stored;

create index skills_search_idx on public.skills using gin (search);
create index skills_name_trgm_idx on public.skills using gin (name extensions.gin_trgm_ops);
create index skills_discipline_idx on public.skills (discipline);
create index skills_author_idx on public.skills (author);

alter table public.skills add column embedding extensions.vector(384);

create table public.skill_installs (
  person_id     text not null references public.people(id) on delete cascade,
  skill_author  text not null,
  skill_id      text not null,
  installed_at  timestamptz not null default now(),
  primary key (person_id, skill_author, skill_id),
  foreign key (skill_author, skill_id)
    references public.skills(author, id) on delete cascade
);

create table public.settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.people         enable row level security;
alter table public.skills         enable row level security;
alter table public.skill_installs enable row level security;
alter table public.settings       enable row level security;
