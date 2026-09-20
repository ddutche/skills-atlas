# Lucid sync

Keeps one Lucid document in step with Supabase by changing only what actually
changed, so the document id and its URL never move and saved links keep working.

```bash
node tools/lucid-sync/plan.test.mjs
```

## Read this before building the scheduled version

**Lucid's REST API cannot edit an existing document's contents.** Checked on
10 August 2026 against Lucid's own documentation, not assumed.

- The Document Contents endpoint is create-only. Lucid's wording: the POST
  Document Contents endpoint can only create a new document, not modify an
  existing document's contents.
- The Update Document endpoint updates a document's title and parent folder.
  Metadata only. It does not reach the canvas.
- There is no REST endpoint to add, edit, move or delete a shape.

The in-place editing this project proved working on 10 August went through the
**MCP server**, which is a different surface from REST. Lucid's own developer
community currently has open requests asking for the MCP's shape editing to be
exposed as REST endpoints, which is itself confirmation that it is not.

The Extension API can modify shapes, but it is JavaScript that runs inside the
Lucid editor. It needs a browser with the document open, so it is no more
unattended than a person is.

### What this means

`pg_cron` plus `pg_net` cannot drive an in-place Lucid sync, because there is
no endpoint for them to call. Both extensions are confirmed available on this
project and not installed (`pg_cron` 1.6.4, `pg_net` 0.20.4), so the blocker is
Lucid's API surface, not Supabase.

Two honest options remain, and picking between them is a decision, not a
technical detail:

1. **Scheduled, but re-created rather than edited.** Creating a document from
   Standard Import *is* a REST call, so a cron job can rebuild the whole
   document unattended. It mints a new document id every time. Saved links
   survive only if people bookmark an indirection instead: a short stable URL
   that looks up the current id in Supabase `settings` and redirects. The Edge
   Function can serve that in a few lines. Cost: comments and version history
   on the old document do not carry over, and the old ones need trashing.
2. **In-place, but not unattended.** Keep the diff below. It only runs when a
   Claude session runs it, so it stops the day whoever runs it stops.

Option 1 is the one that survives the handoff. Option 2 is the one that keeps
the document stable. Only option 1 answers the actual requirement, which was
"something that is not a person runs this."

### A second thing that will bite whichever option is chosen

Whatever Lucid credential the automation holds belongs to **an account**. If it
belongs to the person who built this, the sync dies when their account is
deprovisioned, which is the exact cliff this architecture exists to survive.
Same shape as needing a Supabase *Owner* rather than an Administrator, because
only an Owner can appoint the next one. The Lucid token needs to belong to a
service or shared account, arranged with whoever administers Lucid.

## What the planner does

`plan.mjs` is pure. It takes what Supabase says should exist, what Lucid
currently has, and the saved mapping between them, and returns operations. It
makes no network calls, which is why the whole thing is testable with no token
and no database.

```js
const { add, edit, remove, unchanged, warnings, nextMap } = planSync({
  desired,   // [{ key: "alice/unslop-ui", name: "Unslop UI", disciplineSlot: 3 }]
  present,   // [{ itemId, text, fill_color, x, y, ... }] read back from Lucid
  map,       // { "alice/unslop-ui": { itemId: "BaPj...", slot: 4 } }
});
```

Two rules are deliberate and should not be relaxed:

- **It never touches a shape it did not create.** Anything with no entry in the
  map is reported as a warning and otherwise left completely alone, so someone
  else's annotation survives the sync.
- **A shape that should exist but does not gets re-added**, whether that is a
  new skill or someone deleting a box by hand. Anyone who can edit a Lucid
  document can delete anything in it, and self-healing is a better answer than
  locking the document down.

Slots are stored per skill rather than recomputed each run. If positions were
derived from alphabetical order, one new skill near the top would shift every
box below it and turn a one-shape change into thirty edits.

## State kept in Supabase

Two rows in `settings`:

| key | value |
|---|---|
| `lucid.document_id` | `"0df2f4aa-..."` the document being maintained |
| `lucid.shape_map` | `{ "<author>/<id>": { "itemId": "...", "slot": 0 } }` |

The map is what makes the sync a diff instead of a rebuild, and what lets it
tell its own shapes apart from everyone else's.

## Running it today, by hand

Until the scheduling question above is settled, a Claude session applies the
plan. The applying step is deliberately dumb:

1. Read `lucid.document_id` and `lucid.shape_map` from Supabase `settings`.
2. Read the skills from Supabase.
3. Read the document's current shapes with the Lucid MCP `fetch` tool.
4. Run `planSync`.
5. Apply, in this order: `lucid_delete_items`, then `lucid_edit_item` for each
   edit, then `lucid_add_block` for each add. Deletes first so freed slots are
   genuinely free before anything is placed into them.
6. `lucid_add_block` returns the new `itemId`. Write it into the matching
   `nextMap` entry, then save `nextMap` back to `settings`.

Step 6 is the one that matters. If the new ids are not written back, the next
run cannot tell its own shapes from anyone else's and will add duplicates.

## Both render bugs are fixed here

- **`\n` flattened to a space.** Fixed by not depending on it. The label is the
  skill name on one line, and the discipline is carried by the box colour with
  the legend explaining it. Nothing is lost and there is nothing left to break.
- **Uneven text sizes.** `font_size` is now set explicitly on every shape.
  Left alone, Lucid auto-fits each box independently, so a long name renders
  smaller than a short one beside it and the grid looks ragged.
