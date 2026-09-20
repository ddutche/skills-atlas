# Getting the hub into Lucid

Build the index once, then pick a route:

```bash
node tools/generate-atlas/generate-atlas.mjs --hub ../skill-atlas --emit-index index.json
```

## Route 1: draw.io, which needs nothing from the API

```bash
node tools/lucid-export/lucid-export.mjs --index index.json --out skill-atlas.drawio --drawio
```

In Lucid: **File → Import**, pick the `.drawio` file.

This is the only route that works without API write access, and it is worth
being precise about why. **Standard Import has no File → Import equivalent.**
Lucid's own documentation reaches it "via Lucid's Import Document REST API
endpoint" and nowhere else; the interface imports Visio, Gliffy, OmniGraffle and
draw.io, and `.lucid` is not on that list. So when the API is closed, a `.lucid`
file has no way in at all.

draw.io is plain XML and is on the list, so that is what this emits.

What survives: the arrangement, the person frames with their titles, the
clustering, and every discipline colour. Those are geometry and fills, which any
importer has to honour.

What is lost: draw.io has no data-collection concept. The per-skill metadata
rides along as custom attributes on each cell instead, and whether Lucid keeps
those through an import is untested. Full skill text is not carried at all.

## Route 2: Standard Import, through the API

Higher fidelity: real containers, a data collection behind every shape, a layer
per discipline, and the full text of every skill. Delivered through the REST API
only, so it needs write access.

```bash
# for the REST endpoint
node tools/lucid-export/lucid-export.mjs --index index.json --out skill-atlas.lucid

# for the MCP, which passes JSON as a string and so cannot carry a zip
node tools/lucid-export/lucid-export.mjs --index index.json --out atlas.json --inline
```

Add `--no-markdown` to leave out the skill text. The text is most of the weight:
7KB with it, 87KB without, for eleven skills.

**REST:** `POST https://api.lucid.app/documents`, `multipart/form-data`, with
`file` (content type `x-application/vnd.lucid.standardImport`), `product`
(`lucidchart`), and optionally `title` and `parent`. Headers
`Authorization: Bearer <token>` and `Lucid-Api-Version: 1`.

**MCP:** `lucid_create_diagram_from_specification`, passing the file's contents
as `standard_import_json`, with `use_assisted_layout: false`.

### Status: the connector is read-only

Tested through the MCP connector on 6 August 2026, twice, with a re-authorization
in between.

| | result |
|---|---|
| List folders | works, returns the account's documents |
| Create, 87KB document | 403 Access to this resource is forbidden |
| Create, one rectangle | 403, identical |
| `canEdit` on a document the caller owns | `false` |
| `canEdit` on a second document he owns | `false` |
| Add one block to a document he owns | 403, identical |
| Claude's own tool permissions | all 14 write tools set to Always allow |

Every one of those rules something out:

- Two creates failing identically, at 87KB and at one rectangle, rules out the
  payload.
- `canEdit: false` on documents the signed-in user **owns** rules out sharing
  and ownership.
- An actual write attempt returning the same 403 rules out `canEdit` being a
  stale or conservative flag.
- Claude's tool permissions being fully open rules out this end. The calls left
  and Lucid answered them; a block here would have stopped them before they went.

What is left is the scope the connector's token carries.

Reads working is the tell, and it points away from the plan. Lucid's REST API
and Developer Portal are Team and Enterprise features; free and individual plans
have no API at all. Reads succeed here, so the account is already on a plan that
includes the API. Nothing needs buying.

Lucid's scopes come in pairs, a full one and a `:readonly` one:

| | reads | writes |
|---|---|---|
| `lucid.document.content` | yes | yes |
| `lucid.document.content:readonly` | yes | **no** |

Everything observed is consistent with the connector holding the `:readonly`
variant: reads fine, every write refused, account-wide, regardless of ownership.
That is a re-authorization, not a purchase.

Both routes into Lucid are affected: creating a document and editing an existing
one fail for the same reason. Until it is resolved, `File > Import` in the
browser is the only way in, because it runs as the signed-in user rather than as
the connector.

### Where the key goes

**Not in this repo, and not in a chat window.** In the Apps Script editor:
**Project Settings → Script Properties → Add script property**, named
`LUCID_API_KEY`. One place, inside the Shared Drive the organisation already
owns, so handing over the hub hands over the key. If it has been pasted into a
file, a commit or a message, treat it as burned and roll it.

## Two things the specification says that the sample files do not

Lucid publishes sample documents at
[lucidsoftware/sample-lucid-rest-applications](https://github.com/lucidsoftware/sample-lucid-rest-applications),
and the MCP publishes a specification at `lucid://diagram-specification`. They
disagree, and the specification is what the import validates against:

- **Collections.** The samples use `dataSource: "file.csv"` against a file in
  the zip. The specification requires `values`, an inline array of records. Both
  are emitted here, one per route.
- **Shape text.** The samples use HTML (`<span style=...>`). The specification
  describes plain text plus `style.textColor`. Plain text is used, because it
  works either way.

Also from the specification and worth keeping: every shape's bounding box must
fit **strictly** inside its container with padding on all four sides, shapes
render in array order so containers must come first, all collection values must
be strings, and emoji draw as black boxes. The exporter checks all of these
before it writes.

## What does not fit

`document.json` is capped at 2MB and collection data at 1MB.

The shapes are cheap: 400 skills is 258KB. The full text of every skill is what
runs out. Measured on real skills, averaging around 7KB of markdown, the text
fits **roughly 120 skills**; at 200 it is 987KB and about to go. The exporter
checks, drops the text on its own rather than producing a document Lucid will
refuse, and says so when it does.

Past that, Lucid holds the map and the metadata but not the skills themselves,
and the text keeps living in the hub with the document linking back to it.

## The thing to decide before automating

Import **creates a new document every time**. It does not update one in place.
A scheduled push produces a pile of dated documents, not a living one, and every
saved link points at an old copy.

The MCP has `lucid_add_block`, `lucid_edit_item` and `lucid_delete_items`, which
are edits to an existing document and would keep its URL. That is the version
worth having, and it is currently unavailable for the same reason creation is:
`canEdit` comes back `false` on every document in the account.

Until then, push on demand rather than on a schedule, and delete the previous
document when you replace it.
