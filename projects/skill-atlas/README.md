# Skill Atlas

A shared catalogue of the Claude skills people in a company have written, so
nobody builds the same thing twice and anyone can take a colleague's work.

Built to be usable by people who do not have and do not want a GitHub account.
That constraint drove every design decision here: skills are folders of markdown
in a Drive folder, publishing is a web form, and the only thing anyone has to
understand is "put your thing in, take someone else's out."

## What this is and is not

**It is** a working engine: a browsable atlas, a publish path, a credential and
prompt-injection scanner, a Postgres schema with full-text search, and an MCP
server so a person's Claude can search and publish without opening the site.

**It is not** a product, and it is not deployed anywhere right now. It ran at
one company for about a week, was cancelled, and was lifted out of that company
with the company's own material left behind. See `STATE.md` for exactly what
worked, what never shipped, and what is known broken.

## Layout

```
web/           atlas.html, the whole front end, one file. hub.json is its taxonomy.
apps-script/   Code.gs — the Google Apps Script web app that serves the atlas
               from a Drive folder. Google sign-in, domain-restricted, no server.
supabase/      The other backend. Schema, search functions, the Edge Function
               that is both an MCP server and a plain JSON API, and the scanner.
tools/         Generator, packager, and the SKILL.md files that teach a person's
               Claude to publish to and install from the hub.
lucid/         Abandoned. Kept only for what it proved — see lucid/lucid-sync/README.md.
```

## The two backends

They are alternatives, not layers, and the choice is real:

**Apps Script + Drive.** Free, org-owned, no account to hand over, and Google
sign-in gives you verified identity and domain restriction for nothing. Slow —
Apps Script adds seconds of iframe overhead — and it stops scaling past roughly
a thousand skills, where a cold rebuild hits the six-minute execution cap.

**Supabase.** Search measured at 7ms against the 413ms-per-keystroke the Drive
path costs at a thousand skills. Real auth, real row-level security, and the
MCP. Costs money once you leave the free tier, and the free tier pauses after
about a week of inactivity, which for an internal tool over a quiet week is an
outage.

The original design ran Drive as the source of truth with Supabase as a
rebuildable index over it, so losing Supabase degraded the hub rather than
ending it. That is still the right shape if you are running this for real.

## Getting it running

See `SETUP.md`. The short version: make a Drive folder, paste `Code.gs` into a
new Apps Script project, set `HUB_FOLDER_ID`, deploy. That gets you a working
atlas in about fifteen minutes without touching Supabase at all.

## The one thing worth stealing

If you take nothing else, take `supabase/functions/hub/index.ts` and its test.
The scanner splits its rules in two: a real credential blocks a publish, and
everything else — prompt injection, `rm -rf`, piping curl into a shell — is
flagged and let through. That split is deliberate. A skill about secrets safety
legitimately contains an example API key, and a scanner that refuses it is a
scanner people route around. A scanner people route around protects nothing.
