# Where this stands — 11 August 2026

Lifted out of the company it was built for, on the day the project was
cancelled. Everything below is the engineering record. The company's own
material — its Shared Drive, its people, its skills, its deployed URL — did not
come with it and should not be added back.

Read this before changing anything. Each gotcha near the bottom cost real time
to find, and several of them look like something else entirely.

---

## What it was

A shared catalogue of Claude skills written by people across one company, aimed
squarely at colleagues who would never open GitHub. It ran for about a week and
reached three people and 34 skills, 21 of them published by one colleague who
had nothing to do with building it. That last fact is the only real evidence
the idea worked: someone used it without being asked to.

## Why it stopped

Cancelled for priorities, not for a technical failure. It was working when it
stopped.

Two things found afterwards are worth knowing before restarting it:

**The distribution problem is now a platform feature.** Claude Team and
Enterprise admins can provision skills centrally, and Enterprise gets private
plugin marketplaces. A company on those plans does not need most of this.

**The gap it was really pointed at is still open.** Cowork sessions cannot be
shared — one person's Claude has no visibility into another's. Shared storage
is solved; shared *activity* is not. That is a real gap, and it is also what
SageOx ($15M), Tencent's Team Memory, Mem0 and Cognee are all pointed at. Real,
open, and contested — not unserved.

---

## What was verified, not assumed

| | |
|---|---|
| Supabase full-text search | **7ms** |
| Drive-backed search, 1000 skills | 413ms per keystroke, after a 1.36MB download |
| Drive cold rebuild, 1000 skills | 210–421s — past Apps Script's 6-minute kill |
| Scanner test | 5 credential types refused, 6 documentation examples allowed |
| Deployment mode | `executeAs: USER_ACCESSING`, `access: DOMAIN` — correct |

Scaling, measured rather than estimated:

| | 100 skills | 500 | 1000 |
|---|---|---|---|
| Drive round trips | ~350 | 1,746 | 3,506 |
| Cold build | 21–42s | 105–210s | 210–421s |
| Served page | 145KB | 731KB | 1,361KB |

---

## What never shipped

The deployed script was always an older build than the source. Three things
existed in the source and were never live:

- **`deleteSkill`.** Written, ownership-enforced, wired to a button in
  `atlas.html`. Confirmed absent from the deployed script by reading its source.
- **The `saveLayout` fix.** See the gotcha below. This was the actual cause of
  the slowness everyone complained about.
- **The Edge Function.** Written and scanner-tested. Never deployed, so the MCP
  never existed and nothing ever scanned a publish.

The lesson worth carrying: there was no way to tell what was deployed without
exporting the live script and diffing it. Three copies of the source had
drifted apart and the newest was not the one running. Whatever replaces this
needs one source of truth for what is live.

---

## Gotchas, each one found the hard way

**`saveLayout` must not call `bustCache()`.** It fires automatically after every
drag; `bustCache` deletes the built index; the next visitor rebuilds the whole
hub from Drive. One person nudging a box billed the entire company for a cold
rebuild. This is the single most important line in the project and it is
invisible unless you read both functions together.

**Supabase grants EXECUTE on new functions to `anon` by name.** Stock Postgres
grants to `PUBLIC`, and `anon` inherits — so on stock Postgres, revoking from
`PUBLIC` is the correct and sufficient fix. Supabase also sets ALTER DEFAULT
PRIVILEGES granting to `anon` and `authenticated` explicitly, which a
`PUBLIC`-only revoke does not touch. A migration written specifically to close
this left two write functions open, and the database linter did not catch it
either. Only reading `proacl` directly did.

**A credential scanner that blocks documentation gets switched off.** The
block/flag split exists because the skill teaching people to keep secrets out of
code legitimately contains an example private key header and a
`postgres://user:password@` URL. The first version of the scanner refused it —
the tool would have blocked the thing it was built to protect. Both rules are
now functions that inspect the matched value rather than its shape.

**Standard Import silently drops most of what you attach to a shape.** Tested
with a purpose-built probe, one shape per mechanism: `note` survives;
`customData`, `link` and `linkedData` are all dropped. The import returns
success either way. This cost three documents to notice, because the collection
was being built, validated, sent, accepted and thrown away every time.

**Lucid's REST API cannot edit an existing document.** Document Contents is
create-only and says so; Update Document changes only title and parent folder.
The in-place edits that did work went through the MCP, which is a different
surface and needs a human session. So there is no unattended in-place sync, and
that is what killed Lucid as the front end — not the rendering.

**`Code.gs` at the hub root is a Google Apps Script project, not a text file.**
Writing to it throws "Access denied: DriveApp", which reads like a permissions
problem and is not one. This jammed an install for an entire session.

**Shared Drive writes fail intermittently with the same "Access denied" string**
when permissions are fine. It clears in a second or two, which is why
`writeTextResilient` exists. Any write that matters should use it; the index
write originally did not.

**`Compress-Archive` on PowerShell writes backslash separators**, and every file
then lands flat in the hub root with its whole path as its name. Build update
zips with `tools/make-update/make-update.py`.

**Git Bash on Windows eats one level of backslash in heredocs.** Content with
regex escapes has to be written with an editor, not a `<<'EOF'` heredoc.

**There is no Deno locally, and the Edge Function cannot be imported into Node**
— it calls `Deno.env.get` at the top level and `Deno.serve` at the bottom. The
test extracts the scanner between markers and runs that under Node 22's
`--experimental-strip-types`. Same trick works for any pure logic in that file.

**A pre-write secret hook cannot tell an invented credential from a real one**,
because it matches on shape. That is correct behaviour, and it means a test file
full of fake credentials cannot be written to disk at all. `scan.test.mjs`
assembles its fakes from pieces at runtime instead.

---

## Known broken, in priority order

1. **`sanitizeSvg` is a blocklist and its output is injected raw.** Stored XSS
   in the atlas, and script there can call `google.script.run` as the viewer.
2. **`HUB_TOKEN` is one shared secret** and `X-Hub-User` is self-asserted.
   Cannot be revoked per person. Replace with real per-user auth.
3. **No scanning on the Apps Script publish path.** `publishSkills()` has none.
4. **No `LockService` on profile writes.** Four functions read-modify-write the
   same file, one of them on every drag.
5. **Identity is keyed on an email field in `profile.json`.** A hand-seeded
   folder without one gets a second folder named after the address, and the
   person then cannot delete their own earlier work because ownership compares
   folder names. Two folders claiming one address is worse: the email map is
   built by overwrite, so which identity you get depends on folder iteration
   order.

## Fixed on the way out

- `getIndex` now uses `writeTextResilient` and records a failure to a script
  property surfaced by `getStamp`, instead of logging and going quiet.
- `bustCache` split into `bustCache` (content changed) and `bustPage`
  (bookkeeping changed), with `patchInstall` updating the two numbers that
  actually change when someone takes a skill.
- The grants migration that closes `publish_skill` and `record_install` to
  `anon` — applied and verified against the live database before it was paused.
