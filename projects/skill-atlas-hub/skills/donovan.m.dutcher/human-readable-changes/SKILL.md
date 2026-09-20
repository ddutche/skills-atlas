---
name: human-readable-changes
description: >
  Makes code changes understandable to humans, not just machines, whenever
  writing a database migration or landing a meaningful change on main, via
  a pull request or pushed directly (common on solo projects with no PR
  workflow). Covers: a title + plain-language "what and why" header on
  migration files, approachable inline comments, a concise plain-English
  summary for a non-coder reader (PR description, or commit message +
  changelog entry if there's no PR), a matching CHANGELOG.md entry, rare
  targeted CLAUDE.md updates, and a short project memory afterward for
  continuity. Use whenever creating/editing a migration, opening a PR or
  pushing straight to main, or explaining a change in plain language for a
  non-technical audience, even without the words "documentation" or
  "changelog".
---

# Human-Readable Changes

## Why this exists

Code changes get read by more than just the next engineer. A migration file gets
read six months from now by someone who's forgotten the context. A pull request
gets read by a teammate who doesn't code. The goal here is to leave a trail that
both audiences can follow, without turning every file into a wall of comments or
every PR into a novel. Concise and clear beats thorough and exhausting.

## Migrations (Supabase CLI or any SQL/schema migration)

Never rename or restructure a migration file's auto-generated filename (for
example Supabase's timestamp prefix like `20260731120000_add_users.sql`).
Migration tooling depends on that exact naming to track order and apply state,
so renaming it can break the migration history even if the SQL itself is fine.

Instead, add clarity inside the file:

1. **Title**: a short, descriptive title as the first line, even if a version of
   it is already in the filename. Someone opening the file shouldn't have to
   parse the filename to know what it does.
2. **Header comment block**: right after the title, explain what the migration
   does and *why* it's needed, the actual reason (a bug, a new feature, a
   compliance requirement, a performance fix), not a restatement of the SQL
   that follows. "Adds an index" is not a reason. "Adds an index because the
   orders table lookup was timing out under load" is.
3. **Inline comments**: add them wherever the SQL or logic isn't self-evident,
   non-obvious constraints, indexes, backfills, RLS (row-level security)
   policies, anything a reader would otherwise have to reverse-engineer.

Example header:

```sql
-- Add email verification tracking to users
-- We're adding a verified_at column because we're about to launch email
-- verification and need to know which existing users are grandfathered in
-- (treated as already verified) versus new signups who need to confirm.

ALTER TABLE users ADD COLUMN verified_at timestamptz;

-- Backfill existing users as verified so they aren't locked out when this ships
UPDATE users SET verified_at = created_at WHERE verified_at IS NULL;
```

## Code comments generally (not just migrations)

Write comments so that someone who isn't deep in this codebase, including the
repo owner themselves if they aren't reading code every day, can open a file
and follow what's happening without having to decode it line by line. That
means two things, together, not one instead of the other:

1. **What**: a short plain-language comment on functions, classes, and
   non-trivial blocks describing what they do. A one-line summary is usually
   enough, "checks the user's password against the stored hash and starts a
   session if it matches" beats no comment at all, even if the code is
   "readable" to a professional engineer.
2. **Why**: wherever there's a decision, workaround, or non-obvious constraint
   that the code alone can't explain, add that reasoning too.

Skip a comment only when a line is genuinely self-explanatory to someone
skimming it, `x = x + 1` doesn't need "increment x by one". The bar isn't
"would a senior engineer need this comment," it's "can someone who wants to
understand what's going on, without being a full-time coder, follow along."

Good: `# Checks if the cart total is over $50, and if so, waives the shipping fee`
Also good: `# Retry three times because the payment gateway drops ~1% of requests under load`
Not needed: `# Loop three times` (the code already says this on its own)

Avoid jargon-heavy phrasing where a plainer version says the same thing.
"Debounce this to avoid thrashing the API" should get a few extra words of
plain explanation (what "debounce" means here, what "thrashing" would look
like) rather than being left as shorthand only another engineer would follow.

## Pull requests, or a direct push to main

Not every project uses pull requests, a solo or personal project often
doesn't, since there's no one to review it. The audience and the content
are the same either way, what changes is just where it goes: a PR
description if one exists, otherwise the commit message body (and always
the CHANGELOG entry below, regardless of PR or direct push).

Write it for someone who doesn't code but needs to know what's changing and
why it matters to them (a manager, a teammate on another team, a founder,
or just future-you skimming history). Two things, kept tight:

- **What changed**, described by its effect, not its implementation. "Users can
  now reset their password from the login screen" beats "added a
  ResetPasswordController and email template."
- **Why it matters**, one line if possible: what problem it solves or what it
  unlocks.

Keep it short. No padding, no filler sections, no walking through the diff
file by file. If a technical term is genuinely unavoidable (an API, a specific
service name), use it but briefly say what it means in context rather than
assuming the reader knows.

Example:

```
## Password reset from login

Users who forget their password can now reset it directly from the login
screen instead of emailing support. This should cut down on support tickets
and let people get back into their account in under a minute.
```

## CHANGELOG.md

After writing the PR description (or, on a direct push, alongside the commit),
append a matching entry to `CHANGELOG.md` at the repo root (create the file if
it doesn't exist yet). This is the one piece that always happens regardless of
whether there's a PR, it's what makes the project's history skimmable without
digging through git log or closed PRs. Keep each entry to the same length and
tone as the PR description, a sentence or two, dated.

```markdown
## 2026-07-31
Added password reset from the login screen, so users don't need to email
support to get back into their account.
```

## CLAUDE.md

Don't treat this as a step to run on every PR, it isn't. CLAUDE.md is committed
to the repo and read by every future Claude Code session (and teammates), so
it should stay narrow and stable, not become a running log (that's what
CHANGELOG.md is for).

- Claude Code automatically loads the *root* CLAUDE.md into context already, so
  there's no need to go looking for it. Only search for additional CLAUDE.md
  files if the repo is structured like a monorepo (multiple distinct top-level
  packages or apps), since a CLAUDE.md closer to the code being changed won't
  get auto-loaded from the root session.
- Only propose an edit to CLAUDE.md when the change actually affects something
  a future session would need to know to work correctly in this repo: a new
  convention, a new build or test command, a schema or architecture change, a
  new integration. Routine feature work doesn't need one.
- When an edit is warranted, make it a targeted addition or correction, not a
  rewrite of the file.

## Style, applies to comments, PR descriptions, and changelog entries

- Never use em dashes (—) or en dashes as punctuation. Use commas, periods, or
  parentheses instead.
- Avoid jargon. When a technical term is genuinely unavoidable, briefly explain
  it in plain language the first time it's used.

## After landing the change: save a project memory

Once the summary (PR description or commit message) and CHANGELOG.md entry
are written, also save a
project-type memory using Claude Code's own persistent memory system (the
file-based memory scoped to this project directory, separate from and not
committed to the repo, unlike CLAUDE.md or CHANGELOG.md). This gives a future
session in this same repo continuity on what happened and why, without needing
to re-read the whole changelog or git history.

Follow the memory system's existing format: frontmatter with `name`,
`description`, and `metadata.type: project`, then a body with the fact or
decision, a **Why:** line, and a **How to apply:** line. Keep it as short as
the changelog entry, this is a pointer for future-you, not a duplicate of the
PR description. If a memory system isn't set up for this project, skip this
step rather than trying to invent one.
