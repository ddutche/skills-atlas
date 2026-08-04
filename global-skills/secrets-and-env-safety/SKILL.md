---
name: secrets-and-env-safety
description: >
  Keeps API keys, database URLs, tokens, and other secrets out of git history,
  committed files, and chat. Use this skill whenever creating or editing a
  .env file or any config/settings file, whenever connecting a new service or
  integration (Supabase, Railway, Google APIs, Stripe, etc.) that requires a
  key or credential, whenever about to run `git add` or `git commit`, whenever
  writing code that reads a credential, and whenever a real-looking secret
  (API key, JWT, connection string, private key) shows up anywhere in a file,
  a terminal command, or the conversation. Also use it if the user asks how to
  set up environment variables, deploy with secrets, or mentions accidentally
  committing or leaking a key, even if they don't use the word "secret" or
  "security" explicitly.
---

# Secrets and Environment Safety

## Why this exists

A leaked API key or database credential isn't a code-quality problem, it's a
bill, an outage, or a data breach waiting to happen. Someone scraping public
GitHub repos for exposed keys can find and abuse one within minutes of it
being pushed. This matters more, not less, for a solo or small team without a
dedicated security review process catching it before it ships.

## Never put real secret values in anything that gets committed or shared

This includes source code, config files, migration files, README/CLAUDE.md,
PR descriptions, commit messages, and code comments. Use a reference to an
environment variable instead (`process.env.STRIPE_SECRET_KEY`,
`os.environ["SUPABASE_SERVICE_KEY"]`), never the literal value.

This also applies to this conversation. If you (the user) paste real
credentials into chat for debugging, flag it and suggest replacing the real
value with a placeholder before continuing, since chat history isn't a secure
place to store live keys either.

## Keep secrets out of git entirely

- Before creating a `.env` (or `.env.local`, `.env.production`, etc.) file for
  the first time in a repo, make sure it's listed in `.gitignore` first. If
  `.gitignore` doesn't exist yet, create one.
- Maintain a `.env.example` alongside it with the same variable names but
  placeholder values (`DATABASE_URL=postgres://user:password@host:5432/db`),
  so anyone (including future-you) can see what's required to run the project
  without any real value being exposed. Update it whenever a new variable is
  added to `.env`.
- Before running `git add` or `git commit`, scan the actual diff (not just the
  filenames) for anything that looks like a live secret: long random-looking
  strings, `sk_live_`/`sk_test_` style prefixes, AWS-style access keys, JWTs
  (`eyJ...`), private key blocks (`-----BEGIN PRIVATE KEY-----`), or
  connection strings with an embedded password. If something matches, stop
  and flag it rather than committing, even if the file seems like it should
  be safe (a "temporary" test script, a debug log, a screenshot-adjacent
  fixture file).

## If a secret was already committed

Treat this as urgent, and be direct with the user about both parts:

1. **Rotate it at the source first.** Generate a new key/credential in the
   provider's dashboard (Supabase, Railway, Google Cloud Console, Stripe,
   etc.) and update it wherever it's actually used. The old one should be
   treated as compromised the moment it's confirmed committed, regardless of
   whether the repo is public or private.
2. **Removing it from the latest commit is not enough.** Deleting the line in
   a new commit leaves the secret sitting in git history, still readable by
   anyone with repo access via `git log` or a clone. Actually scrubbing
   history (tools like `git filter-repo` or BFG) is possible but invasive and
   rewrites history for everyone with a clone, so it's a call to make with the
   user, not something to do unprompted, especially on a shared or already
   published repo. Rotating the key is the part that actually neutralizes the
   risk; history-scrubbing is optional cleanup on top of that.

## New integrations and services

When wiring up a new service that needs a credential (a new Supabase project,
a Google API, a payment provider), the credential should flow in through an
environment variable from the start, never hardcoded "just to test it
quickly." It's easy to mean to come back and fix that later and not. If this
introduces a new required environment variable, that's also the kind of
change worth a line in CLAUDE.md (see the human-readable-changes skill for
when CLAUDE.md updates are warranted), so a future session knows the app
won't run without it.
