// Works out what to change in the Lucid document, without changing anything.
//
// This is deliberately a pure function. Give it what Supabase says should
// exist, what Lucid currently has, and the saved mapping between them, and it
// hands back a list of operations. It does no network calls of its own, which
// is what makes it testable on a laptop with no Lucid token and no database.
//
// Whoever applies the plan (today a Claude session calling lucid_add_block /
// lucid_edit_item / lucid_delete_items, see README.md for why it cannot yet be
// a cron job) is a separate, dumb step: run the operations in order, write the
// returned item ids back into the map.
//
// ---------------------------------------------------------------------------
// The two rules that matter most
//
// 1. NEVER touch a shape the sync did not create. If someone drops a comment
//    box or an arrow onto the document, it has no entry in the map, and this
//    planner leaves it completely alone and reports it as a warning. A sync
//    that tidies up after people is a sync people stop trusting.
//
// 2. A shape that should exist but does not gets re-added. That covers both a
//    brand new skill and someone deleting a box by hand. Lucid permissions are
//    per document, so anyone who can edit can delete anything, and the answer
//    to that is for the next sync to quietly put it back rather than to lock
//    the document down.
// ---------------------------------------------------------------------------

// The eight categorical hues, in hub.json slot order. Slot 0 is the neutral.
//
// Duplicated from tools/lucid-export/lucid-export.mjs on purpose: importing
// that file would run its command line. plan.test.mjs reads the exporter's
// source and fails if these two lists ever drift apart, so the copy cannot go
// stale silently.
export const SLOT_COLOUR = {
  0: "#8b8b93",
  1: "#2a78d6", 2: "#eb6834", 3: "#1baf7a", 4: "#eda100",
  5: "#e87ba4", 6: "#008300", 7: "#4a3aa7", 8: "#e34948"
};

// Fills are a wash of the hue rather than the hue itself, so the border stays
// the thing your eye lands on.
export function tint(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = c => Math.round(c + (255 - c) * amount);
  return "#" + [16, 8, 0]
    .map(sh => mix((n >> sh) & 255).toString(16).padStart(2, "0"))
    .join("");
}

// Grid geometry. Matches the exporter's layout so a document created by import
// and a document maintained by sync look the same.
export const GRID = {
  columns: 3,
  boxWidth: 275,
  boxHeight: 76,
  gapX: 14,
  gapY: 14,
  originX: 24,
  originY: 48,
  fontSize: 13,
};

// Where a given slot number sits on the canvas. Slots are stable per skill and
// stored alongside the item id, which is the whole point: if slots were
// recomputed from alphabetical position every run, adding one skill near the
// top would shift every box below it and turn a one-shape change into thirty
// edit calls.
export function gridPosition(slot, grid = GRID) {
  const row = Math.floor(slot / grid.columns);
  const col = slot % grid.columns;
  return {
    x: grid.originX + col * (grid.boxWidth + grid.gapX),
    y: grid.originY + row * (grid.boxHeight + grid.gapY),
    width: grid.boxWidth,
    height: grid.boxHeight,
  };
}

// The text on the box.
//
// One line, no newline character. This is the fix for the render bug found on
// 10 August: a "\n" in shape text does not survive into Lucid, it arrives as a
// space, so "Unslop UI\nUI / UX" rendered as "Unslop UI UI / UX". Rather than
// fight it, the discipline comes off the label entirely. It is already carried
// by the box's colour, and the legend explains the colours, so nothing is lost.
export function labelFor(skill) {
  return String(skill.name || skill.key || "").replace(/\s+/g, " ").trim();
}

// Everything about how one skill should look. Anything in here that differs
// from what Lucid currently has becomes an edit.
export function desiredShape(skill, slot, grid = GRID) {
  const hue = SLOT_COLOUR[skill.disciplineSlot ?? 0] ?? SLOT_COLOUR[0];
  const box = gridPosition(slot, grid);
  return {
    block_type: "RectangleBlock",
    ...box,
    text: labelFor(skill),
    fill_color: tint(hue, 0.86),
    line_color: hue,
    text_color: "#18181b",
    // Set explicitly rather than left to Lucid. This is the fix for the second
    // render bug: left alone, Lucid auto-fits each box's text independently, so
    // a long skill name renders visibly smaller than a short one sitting next
    // to it and the grid looks ragged.
    font_size: grid.fontSize,
  };
}

const COMPARED = ["text", "fill_color", "line_color", "text_color", "font_size",
                  "x", "y", "width", "height"];

// Colours come back from Lucid in whatever case it feels like, and positions
// can come back as floats. Normalise before comparing so the planner does not
// emit an edit for a difference that is not one, which would mean every run
// rewrote every shape forever.
function same(a, b) {
  if (typeof a === "number" || typeof b === "number") {
    return Math.round(Number(a)) === Math.round(Number(b));
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return a === b;
}

/**
 * Compare what should be there against what is there.
 *
 * @param desired  What Supabase says exists. [{ key, name, disciplineSlot }]
 *                 `key` is the stable "author/skill-id", e.g. "alice/unslop-ui".
 * @param present  What the Lucid document currently holds, one entry per shape
 *                 the sync could see. [{ itemId, text, fill_color, x, y, ... }]
 * @param map      The saved mapping, from Supabase settings under
 *                 `lucid.shape_map`. { "<key>": { itemId, slot } }
 * @param grid     Layout overrides, mostly for tests.
 *
 * @returns { add, edit, remove, unchanged, warnings, nextMap }
 */
export function planSync({ desired = [], present = [], map = {}, grid = GRID } = {}) {
  const add = [];
  const edit = [];
  const remove = [];
  const unchanged = [];
  const warnings = [];

  const presentById = new Map(present.map(s => [s.itemId, s]));
  const nextMap = {};

  // Sorted so two runs over the same data produce the same plan. A planner
  // whose output depends on object key order is one that produces spurious
  // diffs and is impossible to test.
  const wanted = [...desired].sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const wantedKeys = new Set(wanted.map(s => s.key));

  // Slots already spoken for by a skill that is sticking around. Held so that a
  // new skill drops into the first genuinely free slot rather than colliding.
  const takenSlots = new Set();
  for (const s of wanted) {
    const known = map[s.key];
    if (known && Number.isInteger(known.slot)) takenSlots.add(known.slot);
  }
  let nextFreeSlot = 0;
  const claimSlot = () => {
    while (takenSlots.has(nextFreeSlot)) nextFreeSlot += 1;
    takenSlots.add(nextFreeSlot);
    return nextFreeSlot;
  };

  for (const skill of wanted) {
    const known = map[skill.key];
    const current = known ? presentById.get(known.itemId) : undefined;

    // No mapping at all, or a mapping pointing at a shape that is no longer in
    // the document. Both mean the same thing to us: draw it.
    if (!current) {
      const slot = known && Number.isInteger(known.slot) ? known.slot : claimSlot();
      add.push({ key: skill.key, slot, block: desiredShape(skill, slot, grid) });
      if (known) {
        warnings.push(
          `${skill.key} was mapped to item ${known.itemId}, which is no longer in the ` +
          `document. Someone probably deleted the box. Re-adding it.`);
      }
      nextMap[skill.key] = { itemId: null, slot };   // caller fills in the new id
      continue;
    }

    const want = desiredShape(skill, known.slot, grid);
    const changes = {};
    for (const field of COMPARED) {
      if (!same(current[field], want[field])) changes[field] = want[field];
    }

    if (Object.keys(changes).length) {
      edit.push({ key: skill.key, itemId: known.itemId, changes });
    } else {
      unchanged.push(skill.key);
    }
    nextMap[skill.key] = { itemId: known.itemId, slot: known.slot };
  }

  // Anything the sync put there for a skill that no longer exists.
  for (const [key, known] of Object.entries(map)) {
    if (wantedKeys.has(key)) continue;
    if (presentById.has(known.itemId)) {
      remove.push({ key, itemId: known.itemId });
    }
    // Either way it leaves the map: the skill is gone from Supabase.
  }

  // Shapes nobody claims. Left strictly alone, see rule 1 at the top.
  const ours = new Set(Object.values(map).map(m => m.itemId));
  for (const shape of present) {
    if (!ours.has(shape.itemId)) {
      warnings.push(
        `Item ${shape.itemId} ("${String(shape.text || "").slice(0, 40)}") is not ` +
        `something the sync created, so it is being left untouched.`);
    }
  }

  return { add, edit, remove, unchanged, warnings, nextMap };
}
