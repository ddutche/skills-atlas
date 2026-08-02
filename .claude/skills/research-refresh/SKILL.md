---
name: research-refresh
description: >
  Dispatch a research pass on a given topic (market data, competitor moves, sales tactics,
  industry trends) to keep intel-hub's knowledge/ base current, then fold validated findings
  back in as dated, sourced records. Use this when the user asks to "look into", "check what's
  current on", "research", or "refresh" a topic, or when a knowledge/ entry is old enough that
  its accuracy should be reconfirmed before being relied on.
---

# Refresh knowledge with research

Notes and conversations only capture what the user already ran into. This skill fills gaps and
keeps existing entries current by actually going and checking, rather than waiting for the user
to stumble onto new information.

## Workflow

### 1. Scope the question

Get a specific, answerable question out of the request, not just a broad topic. "What's changed
in AP automation buying triggers this year" is answerable; "tell me about sales" is not.

### 2. Decide foreground vs. background

A quick, narrow lookup can run in the foreground. Anything requiring multiple searches or a
broader survey should be dispatched as a background research task so it doesn't block the rest
of the session — report back when it lands.

### 3. Research

Use web search/fetch to gather current information. Prefer primary sources and recent material;
note publication dates.

### 4. Convert findings into records

Use the same atomic record schema as `extract-insight`, with `source: research dispatch` and
`confidence: researched`. Cite where each finding came from in the record or immediately after
it.

### 5. Fold into knowledge/

Append new records to the matching `knowledge/*.md` file, dated. If a finding contradicts an
existing entry, do not silently overwrite it: add the new finding, note the contradiction, and
let the user decide which stands (or whether both are true in different contexts).

## Discipline

- Never present a researched claim as `observed` or `inferred`. It gets its own confidence
  level so the user knows to weight it differently.
- Prefer a smaller number of well-sourced findings over a large number of shallow ones.
- If the topic turns out to be unanswerable with available search, say so rather than
  fabricating a plausible-sounding record.
