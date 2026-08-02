---
name: extract-insight
description: >
  Turn a raw file, transcript, note, or conversation into discrete atomic learning-moment
  records using intel-hub's standard schema (date, source, domain, insight, action_implication,
  confidence). Use this whenever the user wants to pull structured takeaways out of something
  they read, watched, or discussed, or when inbox-sort hands off an item that needs extraction
  before it can be filed.
---

# Extract atomic insight records

Raw material (a call summary, a forwarded doc, a note, a conversation) is not itself durable
knowledge. This skill turns it into one or more atomic records, each capturing exactly one
learning moment, before anything gets filed into `knowledge/`, `playbook/`, or `projects/`.

## The schema

```
{
  date,
  source: (file / conversation / research dispatch),
  domain: sales-tactic / market-pattern / product-knowledge / pain-pattern / other,
  insight: the actual learning, stated plainly,
  action_implication: what this suggests doing or changing,
  confidence: observed / inferred / researched
}
```

## Workflow

### 1. Read the whole source first

Do not extract from a partial read. Context earlier in a document or call can change how a
later statement should be interpreted.

### 2. Identify discrete learning moments

A single source can produce multiple records. Do not bundle unrelated insights into one entry
just because they came from the same document. Split by distinct insight, not by paragraph or
speaker turn.

### 3. Fill every field

- **domain**: pick the closest fit; if genuinely cross-cutting, note it and let `inbox-sort`
  decide the primary destination.
- **insight**: state it plainly, as something true independent of the source. Avoid copying
  jargon from the source verbatim if a simpler restatement is available.
- **action_implication**: be concrete. "This suggests X" not "this is interesting."
- **confidence**: `observed` (the user directly saw/heard this), `inferred` (reasonable
  conclusion drawn from context, not stated outright), or `researched` (came from a
  research-refresh dispatch, not from the user's own material).

### 4. Hand off

Return the completed record(s) to whichever process invoked extraction (usually `inbox-sort`)
for routing, or write them directly if the user asked for extraction standalone.

## Discipline

- One insight per record, always.
- Never skip the confidence field. Mixing observed and inferred without marking which is which
  degrades the whole knowledge base's trustworthiness over time.
- If a source contains material that looks like it should stay out of this personal system
  (employer-confidential specifics, names, deal details not yet generalized), flag it to the
  user instead of extracting it silently.
