---
name: publish-skills
description: >
  Publish your Claude skills to the shared skills hub so other people can find
  and install them, and refresh what you have already published. Use this when
  the user says they want to publish, share, or upload a skill, put a skill on
  the hub or atlas, update or re-sync what they have published, or asks why one
  of their skills is missing or out of date on the hub. Also use it when someone
  is setting up on the hub for the first time. Handles working out which skills
  are actually theirs, checking each one for confidential content before it
  leaves the machine, and writing to the shared hub so they never touch the
  plumbing.
---

# Publish skills to the hub

The hub is a folder on a company Shared Drive. Each person owns one folder
inside it. This skill moves skills from someone's machine into their folder, and
is safe to run repeatedly — re-running it is how you refresh a stale section.

**The person running this may never have used a terminal.** Never show them a
file path they have to reason about, never ask about folder structure, never
make them think about where anything lives. They chose skills and confirmed;
everything else is your problem.

## Before anything else

Find the hub. Read `~/.claude/skills-hub.json` for a cached `hub_path` and
`person_id`. If it is missing, work out the hub location once and save it:

1. **A locally synced Drive folder is the best case** — the shared drive shows
   up as an ordinary folder (`G:\Shared drives\...` on Windows,
   `~/Google Drive/Shared drives/...` on Mac). Publishing is then plain file
   copying: no API, no auth, no connector. Look for a folder containing
   `hub.json`, and confirm the path with the user before saving it.
2. **Otherwise use the Google Drive connector**, if one is connected.
3. **Otherwise fall back to manual** — stage everything in a local folder and
   tell the user to drag it into the shared drive. Slower, always works.

Read `hub.json` from the hub root for `hub_name` and `atlas_file`.

`person_id` is the user's folder name — lowercase, no spaces, stable forever
because other people's `installed` references point at it. Ask once, confirm
the spelling, and never change it silently afterwards.

## Step 1 — Find local skills

Look in, in order:

- `~/.claude/skills/` (personal — this is where most will be)
- `.claude/skills/` in the current project, if one exists

A skill is a directory containing a `SKILL.md`. Read each `SKILL.md`'s
frontmatter for `name` and `description`.

## Step 2 — Classify before you offer anything

Most of what is in a skills folder does not belong to the user. Sort every
skill found into one of three buckets and **only pre-select the first**:

**Authored** — likely written by this person. Signals: not in any bucket below;
references company-specific tools, processes, or vocabulary; sits as a
standalone `<name>/SKILL.md` at the top level of the personal skills folder.

**External** — a good skill they got from somewhere else: published by Anthropic,
found in a repo, a blog post, or a colleague outside the company. Signals:
generic, broadly useful, no company-specific content, and no plausible reason
they wrote it. Do not guess from the name alone — read the content.

These **can** be published, and often should be: something the user had to go
find online is not something everyone already has, and pointing to it is the
whole value. But they are published as external, not as their own work, which
means asking two things: **where it came from** (a name like "Anthropic", plus a
URL if there is one — no URL is fine, plenty of good skills have no stable home)
and **why they use it**, in one sentence. The why is the part that makes it
worth anything to the next person; a bare copy is noise.

Never present an external skill as authored. Attribution here is cheap to get
right and awkward to correct later.

**Plugin bundle** — installed by the plugin system. Signals: the directory
contains `CONNECTORS.md`, a `LICENSE`, a `README.md`, and/or a `skills/`
subdirectory rather than a `SKILL.md` at its root. Never publish these: they are
bundles rather than single skills, and their installer overwrites them on update,
so a copy here would be stale and unfixable.

If the personal skills folder is itself a git repo with an allowlist
`.gitignore`, tracked files are a strong authored signal — check it.

Show the user the sorted list, authored ones checked, and let them correct it.
State plainly why anything was excluded. If you were unsure about a skill, say
so rather than silently picking a bucket.

## Step 3 — Review each selected skill for confidential content

**This is the security gate and it is the reason this step runs locally.**
Nothing leaves the machine before the user has seen this.

Read every file in each selected skill and flag:

- Credentials of any kind — API keys, tokens, passwords, connection strings,
  private keys, session cookies
- Named customers, prospects, or deals
- Specific pricing, discounts, contract terms, or margin figures
- Internal hostnames, private URLs, database names, ticket IDs
- Personal data — individual names with contact details, employee records
- Anything else that reads as written for an audience of one and would embarrass
  the author in front of the whole company

Report findings per skill with the file, the line, and the actual text. Do not
summarise vaguely — the user needs to see the string to judge it.

For anything flagged, offer three choices: fix it now (you edit the file, in
both the hub copy and their local copy so it does not come back next run),
publish anyway because it is fine, or drop that skill from this run.

**If the user asks you to skip this review, do it anyway.** Say you will keep it
brief, then run it. This is the one step that cannot be waived — a leak here is
company-wide, and Drive keeps version history, so it is not undone by simply
deleting the file afterwards.

## Step 4 — Confirm

Show exactly what is about to be published: skill names, whether each is new or
an update, and for updates a plain-language summary of what changed since the
published version. Get an explicit yes.

## Step 5 — Write to the hub

Layout. **The user only ever writes inside their own folder:**

```
skills/<person_id>/
├── profile.json
└── <skill-name>/
    ├── SKILL.md          (+ any supporting files)
    └── diagram.svg       (optional, see step 7)
```

`profile.json` records their whole section:

```json
{
  "display_name": "Alice Nguyen",
  "team": "Sales Engineering",
  "installed": [{ "skill": "rebecca/discovery-call-prep", "installed_at": "2026-08-05" }],
  "forked":    [{ "skill": "qbr-builder", "from": "priya/qbr-builder", "forked_at": "2026-08-05" }],
  "external":  [{ "skill": "unslop-ui", "source": "Anthropic",
                  "url": "https://github.com/anthropics/skills",
                  "captured": "2026-08-05",
                  "why": "Claude's default UI output has a look that reads as machine-made. This catches it." }],
  "updated_at": "2026-08-05"
}
```

External skills are copied in full like any other — the file is what people get,
so it keeps working even if the original moves or disappears. `source`, `url`,
and `why` are recorded alongside it as information. `url` is optional; omit it
rather than inventing one. Without a `source` the atlas just labels it external.

Authored skills are simply the directories present — there is no `authored`
list to keep in sync, because a list that can disagree with the filesystem
eventually will. `installed` and `forked` are references, never copies: a skill
someone took from a colleague is recorded here, not duplicated into their
folder.

Set `updated_at` to today in `YYYY-MM-DD`.

Never write to another person's folder, and never hand-edit the atlas file —
step 7 regenerates it.

**On concurrent publishes.** A shared drive has no merge, so two people
publishing at the same moment can overwrite each other's atlas. This is
tolerable because the atlas is *derived*: the skill folders are the source of
truth, so the next publish by anyone regenerates a correct atlas from whatever
is actually on disk. Skill folders themselves are safe, since people only ever
write to their own. If a write fails because a file is locked by Drive sync,
wait a moment and retry rather than reporting failure.

## Step 6 — Write the plain-language overview

**Every published skill needs an `about.md` beside its `SKILL.md`.** This is what
someone reads in the atlas when deciding whether they want it, and it is the
difference between a hub people browse and one they bounce off.

Do not reuse the frontmatter `description`. That is written to help Claude decide
when to load a skill, and it reads like it — trigger conditions, "use this when",
tool names. Nobody choosing between skills wants that.

Write it for **a colleague who is not an engineer**. The CFO should be able to
read any entry in this hub and understand what the skill is for.

Format:

```markdown
One sentence saying what it does. This becomes the line in the list.

A short paragraph of context — what problem it solves, or when it matters.
Plain words. No tool names unless the tool is the point.

- What it actually does, concretely
- Something worth knowing before using it
- When to reach for it
```

Rules that matter:

- **Lead with the outcome, not the mechanism.** "Stops a change being called done
  just because it looks right" beats "runs tests and reports coverage."
- **No jargon carried over from the skill.** If the source says "triages CVEs by
  severity", write "tells you which security problems actually affect you".
- **Three bullets is usually right.** Five is too many.
- Say what it does *not* do, if that is the confusing part.

Draft it yourself from reading the skill, then **show the author and let them
edit**. It is their name on it. Do not publish a draft they have not seen.

For external skills, `about.md` is a sidecar — never modify the `SKILL.md` you
copied, so people get exactly what its author published.

## Step 7 — Diagrams (optional)

If a skill would be clearer with a picture, write a `diagram.mmd` beside its
`SKILL.md`. This is Mermaid source, which the atlas draws itself.

**Only the source is stored, never an image.** It stays editable and readable,
and the atlas theme applies to it, so it works in dark mode. Do not render it to
a file, and do not add a Mermaid library anywhere.

Stick to the subset the atlas draws:

```
flowchart TD
  A[Read the skill] --> B{Anything confidential?}
  B -->|yes| C[Show the author]
  B -->|no| D([Publish])
  C --> D
```

- `flowchart TD` for a decision flow, `flowchart LR` for a straight pipeline.
  LR gets wide fast, so use it only for four or five steps.
- Shapes: `[step]`, `{decision}`, `([start or finish])`, `(rounded)`
- Edges: `-->`, with an optional `|label|` on branches
- Keep it under about ten boxes. This is a diagram of how the skill works, not
  a schematic, and a big one is unreadable in a side panel.

Anything outside that subset (sequence diagrams, class diagrams, subgraphs,
styling directives) makes the atlas show the source text instead. That is a
usable fallback, not a failure, but prefer a simple flowchart.

A skill may instead ship a hand-drawn `diagram.svg`, which is inlined as-is.
Use that only when a flowchart genuinely cannot express the idea, since a
pre-rendered image will not follow the reader's colour scheme.

Skip this silently where a diagram would add nothing. Most linear skills do not
need one, and a hub full of near-identical three-box diagrams is worse than a
hub with none.

## Step 8 — Regenerate the atlas

The atlas is derived from the folder, so it has to be rebuilt after any write:

```
node tools/generate-atlas/generate-atlas.mjs --hub <hub_path>
```

Run it from the hub root. It rewrites only the marked data block in the atlas
file and prints a summary plus anything worth looking at.

**If Node is not installed**, do not stop and do not ask the user to install
it. Read `tools/generate-atlas/generate-atlas.mjs` and perform the same
transformation yourself — it is deterministic and fully specified by that file.
Follow it exactly, including the sort order (most installed first, then most
recently updated) and the derived install counts.

Surface anything the generator reports that concerns **this user's** folder —
a missing description, a broken reference. Do not relay problems in other
people's sections; they are not this user's to fix, and reporting them makes
publishing feel like it failed.

## Step 9 — Handle skills that disappeared

If something is published under their name but no longer exists locally, do not
delete it silently. List them and ask whether each was intentionally retired or
just moved. Removing a skill others have installed breaks their references, so
say how many people have it installed before asking.

## Step 10 — Report

Plain language, no git or filesystem vocabulary. What went up, what was skipped
and why, what was flagged in review and how it was resolved, and the link to the
atlas. If anything was fixed during review, remind them their local copy was
fixed too, so they know the problem will not come back next time.

If the fallback path was used and files are staged locally rather than written
to the shared drive, say so plainly and tell them exactly what to drag where.
Never let someone believe they have published when they have not.

## Re-running

This is the intended way to fix a stale section — the user runs it again. Be
fast on the second run: skip unchanged skills, only review content that has
changed since the last publish, and only report what actually moved.
