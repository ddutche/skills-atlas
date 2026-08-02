# Intel Hub

A personal intelligence system: a single place to drop files, notes, and learning moments from
day-to-day work and have them turned into structured, reusable knowledge, action plans, and
deliverables (documents, diagrams, decks). Single user, single owner. Not connected to any
employer's repo or account.

## Design principles

- **Hub-and-spoke, not mesh.** This session is the one persistent core. It holds memory and
  continuity. When a task needs deep research, heavy document extraction, or a visualization,
  dispatch a subagent for that one bounded job and fold the result back in yourself. Subagents
  never talk to each other directly, and never carry memory between sessions on their own.
- **Ask, don't guess.** If something dropped into `inbox/` is ambiguous (what domain it belongs
  to, whether it's durable knowledge vs. a one-off), ask before filing it. Getting the
  classification wrong quietly is worse than a short clarifying question.
- **Memory-first.** Durable knowledge lives in the files under `knowledge/` and `playbook/`, not
  in chat history. If a fact or pattern is worth keeping, it needs to end up in a file, not just
  in the conversation.
- **Grows incrementally.** Do not invent new structure, categories, or formal process ahead of
  need. Add a new `knowledge/*.md` file when a real new domain shows up, not speculatively.
  Do not build automated evidence-tagging or scoring systems until there's enough volume in
  `playbook/outcomes-log.md` to actually need one.
- **Kept separate from Ottimate's systems on purpose.** This directory is not `ottimate-hub` and
  is not git-connected to it. Material that is Ottimate's confidential deal/customer information
  stays out of here unless it has already been generalized into a pattern with names, company
  identifiers, and employer-specific methodology stripped out. That's a judgment call made by
  the owner at write time, not something enforced by structure, so take care with it.

## Folder map

```
intel-hub/
├── inbox/        Drop zone. Anything unprocessed or ambiguous lands here first.
├── knowledge/    Durable, structured domain knowledge (sales tactics, market patterns,
│                 product positioning, objection patterns, etc.)
├── playbook/     The actionable output layer: prospecting-signals.md (signal -> pain pattern
│                 -> qualifying question -> pitch angle) and outcomes-log.md (plain-language
│                 log of real attempts and what happened)
├── projects/     Active goals/plans that came out of a learning moment, one subfolder each
├── research/     Dated outputs from research subagent dispatches
└── visuals/      Generated diagrams, one-pagers, decks
```

## The atomic record

When extracting a learning moment from anything dropped in, use this shape:

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

## Processing loop

1. Something lands in `inbox/` (a file, a pasted note, a summary of a conversation).
2. Classify it. If unclear, ask before filing.
3. Extract atomic records from it using the schema above.
4. Route records: durable domain knowledge -> `knowledge/`, actionable pattern -> `playbook/`,
   a goal/plan -> a new or existing folder under `projects/`.
5. When a `knowledge/` pattern has enough independent support to be worth acting on, promote it
   into `playbook/prospecting-signals.md`.
6. When the owner acts on a playbook entry, log the outcome in `playbook/outcomes-log.md` in
   plain language.
7. Dispatch a research subagent when current knowledge is stale or a gap is noticed; fold the
   result into the matching `knowledge/*.md` file, dated.
8. Produce a document, diagram, or deck on request via a subagent, saved to `visuals/`.

## House rules

- Plain language. No unexplained jargon carried over from a source document without restating
  it simply.
- One insight per atomic record. Do not bundle multiple learnings into one entry.
- Every `knowledge/` and `playbook/` entry gets a date. Undated entries are not trustworthy
  later.
- Confidence level is not optional on a record. Distinguish something the owner directly
  observed from something inferred from context from something a research subagent found.
