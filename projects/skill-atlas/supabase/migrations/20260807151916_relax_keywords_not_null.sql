-- keywords exists only to feed the generated search column, which already
-- coalesces it. A NOT NULL bought nothing and gave every importer a way to fail
-- on a skill that simply has no tags.
alter table public.skills alter column keywords drop not null;
