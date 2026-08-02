---
name: pattern-to-playbook
description: >
  Promote a well-supported knowledge/ pattern into an actionable playbook/prospecting-signals.md
  entry (signal -> pain pattern -> qualifying question -> pitch angle). Use this when the user
  says a pattern has "come up enough" or "is solid now", wants to turn accumulated knowledge into
  something usable on a live call, or asks what's ready to promote from knowledge into the
  playbook.
---

# Promote a pattern into the playbook

`knowledge/` accumulates observations. `playbook/prospecting-signals.md` is for patterns solid
enough to act on directly, mid-conversation, with a prospect or client. Not everything in
knowledge/ deserves to be here yet.

## Workflow

### 1. Check the evidence bar

Before promoting, look at how many independent records in `knowledge/` support this pattern, and
their confidence levels. A single `inferred` record is not enough on its own. Prefer patterns
with multiple `observed` records, or at least one `observed` plus corroborating `researched`
findings.

If the user wants to promote something thin anyway, that's their call, but say so explicitly:
name it as a low-evidence promotion rather than silently treating it as equally solid.

### 2. Write the entry

```
### {YYYY-MM-DD} {short title}
- **Signal:** what to notice (an industry trait, a company stage, a stated complaint)
- **Pain pattern:** what it usually means underneath
- **Qualifying question:** how to confirm it in a conversation
- **Pitch angle:** how to frame the solution once confirmed
- **Evidence:** how many times this has held up, and how
```

Keep the qualifying question genuinely usable out loud, in conversation, not a written-report
phrasing.

### 3. Confirm

Show the user the entry as written and where it landed in `playbook/prospecting-signals.md`.

## Discipline

- Do not promote directly from raw source material. Only promote from existing `knowledge/`
  entries that have already been through `extract-insight`.
- Every playbook entry names its evidence. An entry with no stated evidence is not trustworthy
  later, even to the person who wrote it.
- Revisit promoted entries periodically against `playbook/outcomes-log.md` — a pattern that
  keeps losing in practice should be flagged for review, not left standing on old evidence.
