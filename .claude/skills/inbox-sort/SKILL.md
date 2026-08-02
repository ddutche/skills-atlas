---
name: inbox-sort
description: >
  Classify and route whatever has been dropped into intel-hub's inbox/ folder, or pasted
  directly into the conversation, to the correct destination: knowledge/, playbook/, projects/,
  or research/. Asks a clarifying question when the classification is ambiguous rather than
  guessing. Use this whenever the user says "sort my inbox", "process what I dropped in", "file
  this", or drops a new file/note/transcript into the hub without saying where it should go.
---

# Sort the inbox

This is the front door of the hub. Nothing gets filed silently if it's ambiguous.

## Workflow

### 1. Find what needs sorting

Check `inbox/` for files. If the user pasted content directly instead of dropping a file, treat
that pasted content as the item to sort.

### 2. Classify each item

For each item, decide:

- **Domain knowledge** (durable, generalizable fact or pattern) -> goes toward `knowledge/`
- **Actionable pattern** (specific enough to act on directly, already well-supported) -> goes
  toward `playbook/`
- **A goal or plan** (something to do, not something to know) -> goes toward `projects/`
- **Research output** (from a research-refresh dispatch) -> goes toward `research/`
- **Not durable** (a one-off, no lasting value) -> flag it and ask if it should be discarded

If it's not clear which bucket an item belongs in, or which `knowledge/*.md` file it belongs in,
ask the user rather than picking one. A wrong guess here compounds every time the knowledge base
is read later.

### 3. Extract and route

Once classified, hand off to `extract-insight` to pull atomic records out of the item, then
place the resulting record(s) in the destination file(s) determined above.

### 4. Confirm

Tell the user what was classified as what, and where each thing landed. If anything was
discarded as non-durable, say so explicitly rather than silently dropping it.

## Discipline

- Never file something into `knowledge/` or `playbook/` without going through `extract-insight`
  first — raw dumps of source material do not belong in those files, only extracted records do.
- When truly unsure between two domains, ask instead of picking the more likely one.
- Clear `inbox/` of anything successfully filed; leave ambiguous items in place until resolved.
