// Tests the Lucid sync planner.
//
//   node tools/lucid-sync/plan.test.mjs
//
// No Lucid token, no database, no network. The planner is pure, which is the
// reason it was written that way: the risky part of a sync is deciding what to
// change, and that part can be checked exhaustively on a laptop.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planSync, desiredShape, gridPosition, labelFor, tint, SLOT_COLOUR, GRID } from "./plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want),
        `got ${JSON.stringify(got)}\n          want ${JSON.stringify(want)}`);

// A stand-in hub: three skills, each a different discipline.
const skills = [
  { key: "alice/alpha",  name: "Alpha",  disciplineSlot: 1 },
  { key: "alice/bravo",  name: "Bravo",  disciplineSlot: 2 },
  { key: "bob/charlie", name: "Charlie", disciplineSlot: 7 },
];

// Builds what Lucid would report for a shape the sync had already drawn.
const asPresent = (itemId, skill, slot) => ({ itemId, ...desiredShape(skill, slot) });

console.log("\nFirst run, empty document:\n");
{
  const p = planSync({ desired: skills, present: [], map: {} });
  eq("adds one shape per skill", p.add.map(a => a.key),
     ["alice/alpha", "alice/bravo", "bob/charlie"]);
  eq("assigns slots from zero", p.add.map(a => a.slot), [0, 1, 2]);
  check("nothing to edit", p.edit.length === 0);
  check("nothing to remove", p.remove.length === 0);
  check("no warnings", p.warnings.length === 0, p.warnings.join(" | "));
}

console.log("\nNothing changed:\n");
{
  const map = {
    "alice/alpha":    { itemId: "i1", slot: 0 },
    "alice/bravo":    { itemId: "i2", slot: 1 },
    "bob/charlie": { itemId: "i3", slot: 2 },
  };
  const present = [
    asPresent("i1", skills[0], 0),
    asPresent("i2", skills[1], 1),
    asPresent("i3", skills[2], 2),
  ];
  const p = planSync({ desired: skills, present, map });
  check("issues no operations at all", !p.add.length && !p.edit.length && !p.remove.length,
        `add=${p.add.length} edit=${p.edit.length} remove=${p.remove.length}`);
  eq("reports all three as unchanged", p.unchanged.length, 3);
}

console.log("\nA skill was renamed:\n");
{
  const map = { "alice/alpha": { itemId: "i1", slot: 0 } };
  const present = [asPresent("i1", skills[0], 0)];
  const renamed = [{ key: "alice/alpha", name: "Alpha Renamed", disciplineSlot: 1 }];
  const p = planSync({ desired: renamed, present, map });
  eq("edits exactly one shape", p.edit.length, 1);
  eq("changes only the text", Object.keys(p.edit[0].changes), ["text"]);
  eq("to the new name", p.edit[0].changes.text, "Alpha Renamed");
  check("reuses the same item", p.edit[0].itemId === "i1");
}

console.log("\nA skill changed discipline:\n");
{
  const map = { "alice/alpha": { itemId: "i1", slot: 0 } };
  const present = [asPresent("i1", skills[0], 0)];
  const recoloured = [{ key: "alice/alpha", name: "Alpha", disciplineSlot: 7 }];
  const p = planSync({ desired: recoloured, present, map });
  eq("changes both colours and nothing else",
     Object.keys(p.edit[0].changes).sort(), ["fill_color", "line_color"]);
  eq("to the security hue", p.edit[0].changes.line_color, SLOT_COLOUR[7]);
}

console.log("\nA skill was deleted from Supabase:\n");
{
  const map = {
    "alice/alpha": { itemId: "i1", slot: 0 },
    "alice/bravo": { itemId: "i2", slot: 1 },
  };
  const present = [asPresent("i1", skills[0], 0), asPresent("i2", skills[1], 1)];
  const p = planSync({ desired: [skills[0]], present, map });
  eq("removes exactly the one shape", p.remove, [{ key: "alice/bravo", itemId: "i2" }]);
  check("drops it from the map", !("alice/bravo" in p.nextMap));
  check("leaves the survivor alone", p.unchanged.includes("alice/alpha"));
}

console.log("\nSomeone deleted a box by hand:\n");
{
  const map = {
    "alice/alpha": { itemId: "i1", slot: 0 },
    "alice/bravo": { itemId: "i2", slot: 1 },
  };
  const present = [asPresent("i1", skills[0], 0)];        // i2 is gone
  const p = planSync({ desired: [skills[0], skills[1]], present, map });
  eq("puts it back", p.add.map(a => a.key), ["alice/bravo"]);
  eq("in the slot it used to occupy", p.add[0].slot, 1);
  check("and says why", p.warnings.some(w => w.includes("i2")), p.warnings.join(" | "));
}

console.log("\nSomeone added their own shape:\n");
{
  const map = { "alice/alpha": { itemId: "i1", slot: 0 } };
  const present = [
    asPresent("i1", skills[0], 0),
    { itemId: "human1", text: "note to self: ask Joe about this", x: 900, y: 900 },
  ];
  const p = planSync({ desired: [skills[0]], present, map });
  check("never deletes it", p.remove.length === 0);
  check("never edits it", p.edit.length === 0);
  check("mentions it", p.warnings.some(w => w.includes("human1")), p.warnings.join(" | "));
}

console.log("\nA new skill lands while others stay put:\n");
{
  const map = {
    "alice/alpha":    { itemId: "i1", slot: 0 },
    "bob/charlie": { itemId: "i3", slot: 2 },
  };
  const present = [asPresent("i1", skills[0], 0), asPresent("i3", skills[2], 2)];
  const p = planSync({ desired: skills, present, map });
  eq("adds only the newcomer", p.add.map(a => a.key), ["alice/bravo"]);
  eq("into the free slot between them", p.add[0].slot, 1);
  check("and moves nothing else", p.edit.length === 0,
        `unexpected edits: ${JSON.stringify(p.edit)}`);
}

console.log("\nThe two render bugs:\n");
{
  const label = labelFor({ name: "Unslop UI", disciplineSlot: 3 });
  check("label carries no newline, so nothing can flatten to a space",
        !label.includes("\n"), JSON.stringify(label));
  eq("label is just the name", label, "Unslop UI");

  const a = desiredShape({ key: "x/a", name: "A", disciplineSlot: 1 }, 0);
  const b = desiredShape({ key: "x/b", name: "A Very Much Longer Skill Name", disciplineSlot: 1 }, 1);
  check("font size is set explicitly, not left to auto-fit", a.font_size === GRID.fontSize);
  check("and is identical for a short and a long name", a.font_size === b.font_size,
        `${a.font_size} vs ${b.font_size}`);
}

console.log("\nGeometry:\n");
{
  eq("slot 0 sits at the origin", gridPosition(0),
     { x: 24, y: 48, width: 275, height: 76 });
  eq("slot 3 wraps to the second row", gridPosition(3),
     { x: 24, y: 48 + 76 + 14, width: 275, height: 76 });
  check("boxes in a row do not overlap",
        gridPosition(1).x >= gridPosition(0).x + gridPosition(0).width);
}

console.log("\nPalette has not drifted from the exporter:\n");
{
  // Reads the exporter's source rather than importing it, because importing
  // would run its command line. Same trick as the Edge Function scanner test.
  const src = readFileSync(join(here, "..", "lucid-export.mjs"), "utf8");
  const block = src.slice(src.indexOf("const SLOT_COLOUR"));
  const theirs = {};
  for (const m of block.slice(0, block.indexOf("};")).matchAll(/(\d+):\s*"(#[0-9a-fA-F]{6})"/g)) {
    theirs[m[1]] = m[2].toLowerCase();
  }
  const mine = Object.fromEntries(
    Object.entries(SLOT_COLOUR).map(([k, v]) => [k, v.toLowerCase()]));
  check("found the exporter's palette", Object.keys(theirs).length === 9,
        `found ${Object.keys(theirs).length} entries`);
  eq("every slot matches", mine, theirs);

  // tint is duplicated too, so spot-check it produces the same wash.
  check("tint still lightens toward white", tint("#000000", 0.86) === "#dbdbdb",
        tint("#000000", 0.86));
}

console.log(failures ? `\n${failures} failure(s).` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
