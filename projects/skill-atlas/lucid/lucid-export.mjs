#!/usr/bin/env node
/**
 * lucid-export: turn the hub into a Lucid document.
 *
 *   node tools/generate-atlas/generate-atlas.mjs --hub <hub> --emit-index index.json
 *   node tools/lucid-export/lucid-export.mjs --index index.json --out skills.lucid
 *
 * Writes a `.lucid` file: Lucid's Standard Import format, which is a zip
 * containing document.json and an optional /data folder. Import it at
 * lucid.app, or POST it to https://api.lucid.app/documents (see push-to-lucid.md).
 *
 * It does not read the hub itself. It consumes the index that generate-atlas
 * emits, so the atlas and the Lucid document are guaranteed to be showing the
 * same reading of the same files rather than two parsers that drift.
 *
 * Zero dependencies, no network. Writing the zip by hand is a few lines and
 * saves the whole toolchain a package it would otherwise have to trust.
 *
 * Format reference: https://developer.lucid.co/v1.0/docs/overview-si
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const INDEX = resolve(arg("--index", "index.json"));
const OUT = resolve(arg("--out", "skill-atlas.lucid"));

// When given, every skill box links back to the live atlas.
const ATLAS_URL = arg("--atlas-url", "");

// Two shapes of the same document, because the two ways in differ.
//
//   file (default)  a .lucid zip whose collection points at data/skills.csv.
//                   This is what File > Import and the REST endpoint take.
//   --inline        a bare .json with the collection's rows written into the
//                   document itself. This is what the MCP takes, because it
//                   passes JSON as a string and there is no zip to hold a CSV.
const INLINE = argv.includes("--inline");

// --drawio writes a .drawio file instead. Lucid's interface imports draw.io,
// and does not import .lucid, so this is the only route that works without API
// write access. See PUSH.md.
const DRAWIO = argv.includes("--drawio");

// ---------------------------------------------------------------------------
// geometry
//
// The same arrangement the atlas draws, scaled up. The atlas is sized for a
// browser at 100%; Lucid documents are read zoomed out, and boxes that carry a
// skill name plus an author need the room.
// ---------------------------------------------------------------------------
const SCALE = 1.35;
const SK_W = Math.round(204 * SCALE);
const SK_H = Math.round(56 * SCALE);
const SK_GAP = Math.round(10 * SCALE);
const P_PAD = Math.round(18 * SCALE);
// containerTitle renders above the container rather than inside it, so the
// band the atlas reserves for a person's name is not needed here.
const P_HEAD = P_PAD;
const P_GAP = Math.round(54 * SCALE);

// The eight categorical hues from the atlas, in hub.json slot order. Slot 0 is
// the neutral. These were chosen for colour-blind separation on this exact
// adjacency, so keep them paired with the slot numbers in hub.json.
const SLOT_COLOUR = {
  0: "#8b8b93",
  1: "#2a78d6", 2: "#eb6834", 3: "#1baf7a", 4: "#eda100",
  5: "#e87ba4", 6: "#008300", 7: "#4a3aa7", 8: "#e34948"
};

// Fills are a wash of the same hue rather than the hue itself, so the tag on
// the box stays the thing your eye lands on.
function tint(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = c => Math.round(c + (255 - c) * amount);
  return "#" + [16, 8, 0]
    .map(sh => mix((n >> sh) & 255).toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// a zip, by hand
// ---------------------------------------------------------------------------
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, body } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(body, "utf8");
    const packed = deflateRawSync(raw);
    const sum = crc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);

    chunks.push(local, nameBuf, packed);
    central.push(Buffer.concat([dir, nameBuf]));
    offset += local.length + nameBuf.length + packed.length;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, dirBuf, end]);
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------
// Shape text is plain, not HTML. Lucid's own sample documents use inline spans,
// but the specification the MCP hands out describes text as plain, and plain
// renders correctly on both routes.
//
// Emoji are stripped because Lucid draws them as black boxes.
//
// deEmoji is deliberately its own function rather than a step inside plain.
// The skill text column keeps its line breaks, so it cannot go through plain,
// which collapses whitespace. When the emoji strip lived only inside plain,
// that column silently kept its emoji and the full-text export carried black
// boxes into the data panel. Every string heading for Lucid needs deEmoji;
// only the ones that also want their whitespace flattened need plain.
// Notes are multi-line, unlike shape labels. Built from a char code so a Git
// Bash heredoc cannot eat the escape on the way into this file.
const NL = String.fromCharCode(10);

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0F}]/gu;
const deEmoji = s => String(s == null ? "" : s).replace(EMOJI, "");
const plain = s => deEmoji(s).replace(/\s+/g, " ").trim();

// A CSV cell. Quote everything: skill descriptions are prose and contain
// commas, quotes and newlines, and a half-quoted file is worse than a big one.
const cell = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';

function csv(rows, columns) {
  return [columns.join(",")]
    .concat(rows.map(r => columns.map(c => cell(r[c])).join(",")))
    .join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
const index = JSON.parse(readFileSync(INDEX, "utf8"));

const discLabel = {};
const discSlot = {};
for (const d of index.DISCIPLINES || []) {
  discLabel[d.id] = d.label;
  discSlot[d.id] = d.slot || 0;
}

const personById = Object.fromEntries((index.PEOPLE || []).map(p => [p.id, p]));
const skills = index.SKILLS || [];
const keyOf = s => `${s.author}/${s.id}`;

// Group by person, in the same order the atlas uses.
const byPerson = new Map();
for (const s of skills) {
  if (!byPerson.has(s.author)) byPerson.set(s.author, []);
  byPerson.get(s.author).push(s);
}
const people = [...byPerson.entries()].sort((a, b) =>
  ((personById[a[0]] || {}).name || a[0]).localeCompare((personById[b[0]] || {}).name || b[0]));

const shapes = [];
const frames = [];

// Shape ids are numbered rather than built from names. "skill-a-b-c" is
// ambiguous between person "a-b" skill "c" and person "a" skill "b-c", and a
// duplicate id silently loses a shape on import.
let shapeSeq = 0;
const rows = [];
const layerItems = {};

let cursorX = 0, rowY = 0, rowTall = 0, inRow = 0;
const perRow = Math.max(1, Math.ceil(Math.sqrt(people.length)));

for (const [pid, list] of people) {
  const who = personById[pid] || { name: pid, role: "" };
  const cols = Math.min(3, Math.max(1, Math.round(Math.sqrt(list.length))));
  const nRows = Math.ceil(list.length / cols);

  const frameW = cols * SK_W + (cols - 1) * SK_GAP + P_PAD * 2;
  const frameH = nRows * SK_H + (nRows - 1) * SK_GAP + P_HEAD + P_PAD * 2;

  // The frame goes in first so it paints behind the boxes, which is exactly
  // how the atlas stacks them.
  const frameId = `frame-${++shapeSeq}`;

  frames.push({
    id: frameId,
    type: "rectangleContainer",
    boundingBox: { x: cursorX, y: rowY, w: frameW, h: frameH },
    style: { fill: { type: "color", color: "#fafafa" }, stroke: { color: "#d4d4d8", width: 2 } },
    containerTitle: {
      text: plain(`${who.name} · ${who.role || "No team set"} · ` +
                  `${list.length} skill${list.length === 1 ? "" : "s"}`)
    },
    // The arrangement is the point. It mirrors what people already see in the
    // atlas, and each person is a deliberate cluster rather than a flowchart,
    // so letting Lucid re-lay it out would throw away the only thing the
    // positions mean.
    assistedLayout: false
  });

  list.forEach((s, i) => {
    const slot = discSlot[s.discipline] || 0;
    const colour = SLOT_COLOUR[slot];
    const k = keyOf(s);
    const label = plain(s.name);

    const shapeId = `skill-${++shapeSeq}`;

    shapes.push({
      id: shapeId,
      type: "rectangle",
      boundingBox: {
        x: cursorX + P_PAD + (i % cols) * (SK_W + SK_GAP),
        y: rowY + P_HEAD + P_PAD + Math.floor(i / cols) * (SK_H + SK_GAP),
        w: SK_W, h: SK_H
      },
      style: {
        fill: { type: "color", color: tint(colour, 0.86) },
        stroke: { color: colour, width: 2 },
        textColor: "#18181b"
      },
      // The name only, on one line.
      //
      // This used to be name + "\n" + discipline. A newline does not survive
      // Standard Import, it arrives as a space, so every box read "Unslop UI
      // UI / UX". The discipline now lives in the box's colour and the legend
      // built below explains the colours, which is how the atlas does it too.
      text: label,

      // Everything a reader needs beyond the name, as a note.
      //
      // Notes are the ONLY per-shape channel that survives Standard Import.
      // Tested on 10 August with a four-way probe document: `note` came back
      // on the shape, while `customData`, `link` and `linkedData` were all
      // silently dropped. The import reports success either way, which is what
      // made this take three documents to notice.
      //
      // So the collection route is dead for carrying detail. This is the
      // replacement, and it is better anyway: a note needs no data panel, no
      // data source registration, and no 1MB collection budget.
      note: [
        `${who.name}${who.role ? " · " + who.role : ""}`,
        [discLabel[s.discipline] || s.discipline || "General",
         s.kind === "external" ? `external (${s.source || "unknown"})` : "written at your company",
         `${s.installs == null ? 0 : s.installs} installed`,
         s.updated ? `updated ${s.updated}` : ""
        ].filter(Boolean).join(" · "),
        "",
        plain(s.desc) || "(no description set on this skill)"
      ].join(NL),
      // No linkedData and no link here. Both were tried and both are dropped
      // by Standard Import without an error, see the note above. A per-shape
      // link is still achievable, but only as a second pass through the MCP's
      // edit tool after the document exists, which is why ATLAS_URL now goes
      // into the header box instead.
    });

    (layerItems[s.discipline || "general"] ||= []).push(shapeId);

    rows.push({
      key: k,
      skill: s.name,
      person: who.name,
      team: who.role || "",
      department: s.dept || "",
      discipline: discLabel[s.discipline] || s.discipline || "",
      origin: s.kind === "external" ? `external (${s.source || "unknown"})` : "written at your company",
      installs: s.installs == null ? 0 : s.installs,
      updated: s.updated || "",
      description: s.desc || "",
      skill_markdown: s.src || ""
    });
  });

  cursorX += frameW + P_GAP;
  rowTall = Math.max(rowTall, frameH);
  if (++inRow >= perRow) { inRow = 0; cursorX = 0; rowY += rowTall + P_GAP; rowTall = 0; }
}

// ---------------------------------------------------------------------------
// The legend
//
// Load-bearing, not decoration. Now that a skill box shows only its name, the
// colour is the only thing carrying the discipline, and a colour with nothing
// to decode it against is just a colour. This is the key.
//
// It goes above everything, so the whole diagram is shifted down to make room
// rather than the legend being tucked into a corner where it gets missed. The
// shift is applied to every frame and every skill box by the same amount, so
// nothing moves relative to anything else and every box stays inside its
// person's frame.
// ---------------------------------------------------------------------------
const LEGEND_H = Math.round(30 * SCALE);
const LEGEND_W = Math.round(150 * SCALE);
const LEGEND_GAP = Math.round(10 * SCALE);
const LEGEND_DROP = LEGEND_H + Math.round(40 * SCALE);

const used = (index.DISCIPLINES || []).filter(d => layerItems[d.id] && layerItems[d.id].length);

for (const f of frames) f.boundingBox.y += LEGEND_DROP;
for (const s of shapes) s.boundingBox.y += LEGEND_DROP;

// A header telling a first-time viewer what this is and what to do with it.
// Without it the document is a wall of coloured boxes with no way in: the
// per-shape link does not survive import, so this carries the atlas address.
const header = [{
  id: "header",
  type: "rectangle",
  boundingBox: {
    x: 0,
    y: -(LEGEND_H + Math.round(56 * SCALE)),
    w: Math.round(1100 * SCALE),
    h: Math.round(46 * SCALE)
  },
  style: {
    fill: { type: "color", color: "#ffffff" },
    stroke: { color: "#ffffff", width: 1 },
    textColor: "#18181b"
  },
  text: plain(
    `Skill Atlas · ${skills.length} skills · ${people.length} ` +
    `${people.length === 1 ? "person" : "people"} · ${index.UPDATED || ""}   ` +
    `Click a skill for its description. Ask Claude to install one.` +
    (ATLAS_URL ? `   Full atlas: ${ATLAS_URL}` : ""))
}];

const legend = used.map((d, i) => {
  const colour = SLOT_COLOUR[d.slot || 0];
  return {
    id: `legend-${d.id}`,
    type: "rectangle",
    boundingBox: { x: i * (LEGEND_W + LEGEND_GAP), y: 0, w: LEGEND_W, h: LEGEND_H },
    style: {
      fill: { type: "color", color: tint(colour, 0.86) },
      stroke: { color: colour, width: 2 },
      textColor: "#18181b"
    },
    text: plain(d.label)
  };
});

// One layer per discipline, which is the nearest thing the canvas has to the
// discipline checklist in the atlas.
//
// Layers appear in Lucid's own published sample documents but not in the
// specification the MCP hands out, so they are left out of the inline route
// rather than risking the whole import on an undocumented field. Frames are
// never in a layer, so hiding a discipline never hides a person.
const layers = (index.DISCIPLINES || [])
  .filter(d => layerItems[d.id] && layerItems[d.id].length)
  .map(d => ({ id: `layer-${d.id}`, title: d.label, items: layerItems[d.id] }));

const COLUMNS = ["key", "skill", "person", "team", "department", "discipline",
                 "origin", "installs", "updated", "description", "skill_markdown"];

// Collection data is capped at 1MB. Carrying every skill's full text is what
// runs that out, and it is the one column the hub itself still has, so it is
// dropped rather than producing a document Lucid refuses.
const MB = 1024 * 1024;
const clean = rows.map(r => {
  const out = {};
  // The skill text keeps its line breaks, so it gets the emoji strip on its
  // own. Everything else is a single-line label and gets both.
  for (const c of COLUMNS) out[c] = c === "skill_markdown" ? deEmoji(r[c]) : plain(r[c]);
  return out;
});

// Worth having as a switch and not only as an automatic fallback: the inline
// route passes the document as one argument, and the skill text is most of its
// weight. Leaving it out is the difference between a 4KB call and an 87KB one.
let columnsUsed = argv.includes("--no-markdown")
  ? COLUMNS.filter(c => c !== "skill_markdown")
  : COLUMNS;
let droppedText = false;
const size = cols => Buffer.byteLength(
  INLINE ? JSON.stringify(clean.map(r => Object.fromEntries(cols.map(c => [c, String(r[c])]))))
         : csv(clean, cols), "utf8");

if (size(columnsUsed) > MB * 0.95) {
  columnsUsed = columnsUsed.filter(c => c !== "skill_markdown");
  droppedText = true;
}

const records = clean.map(r =>
  Object.fromEntries(columnsUsed.map(c => [c, String(r[c] == null ? "" : r[c])])));
const data = csv(clean, columnsUsed);

// ---------------------------------------------------------------------------
// draw.io
//
// The route that needs nothing from Lucid's API.
//
// Standard Import, the format everything above builds, can only be delivered
// through the REST endpoint. There is no File > Import equivalent for it. So
// when the API is closed, a .lucid file has no way in at all.
//
// Lucid's interface does import Visio, Gliffy, OmniGraffle and draw.io. Of
// those, draw.io is plain XML and the only one worth generating by hand.
//
// What it costs: draw.io has no data-collection concept, so the per-skill
// metadata rides along as custom attributes on each cell instead. Whether
// Lucid keeps those through an import is untested. The map, the clustering and
// the discipline colours are the part that matters and they are all geometry
// and fills, which any importer has to honour.
// ---------------------------------------------------------------------------
const xml = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function drawio() {
  const cells = [];

  // Frames first. draw.io paints in document order, so anything listed earlier
  // sits behind, which is the same stacking the atlas uses.
  for (const f of frames) {
    const b = f.boundingBox;
    cells.push(
      `        <mxCell id="${xml(f.id)}" value="${xml(f.containerTitle.text)}" vertex="1" parent="1"` +
      ` style="rounded=0;html=1;whiteSpace=wrap;fillColor=${f.style.fill.color};` +
      `strokeColor=${f.style.stroke.color};strokeWidth=2;verticalAlign=top;align=left;` +
      `spacingLeft=14;spacingTop=6;fontSize=16;fontStyle=1;fontColor=#18181b;">\n` +
      `          <mxGeometry x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" as="geometry" />\n` +
      `        </mxCell>`);
  }

  for (const s of shapes) {
    const b = s.boundingBox;
    const row = byKey[s.linkedData[0].key] || {};
    const style =
      `rounded=1;arcSize=8;html=1;whiteSpace=wrap;fillColor=${s.style.fill.color};` +
      `strokeColor=${s.style.stroke.color};strokeWidth=2;fontSize=12;fontColor=#18181b;`;

    // An <object> wrapper is how draw.io carries arbitrary attributes on a cell.
    // Same fields as the Standard Import collection, so the two routes describe
    // each skill identically.
    const attrs = columnsUsed
      .filter(c => c !== "skill_markdown")
      .map(c => `${c}="${xml(row[c])}"`).join(" ");

    cells.push(
      `        <object id="${xml(s.id)}" label="${xml(s.text.replace(/\n/g, "<br>"))}" ${attrs}>\n` +
      `          <mxCell vertex="1" parent="1" style="${style}">\n` +
      `            <mxGeometry x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" as="geometry" />\n` +
      `          </mxCell>\n` +
      `        </object>`);
  }

  // The declaration is not optional here. Person titles carry a middle dot,
  // and an importer that guesses the encoding renders it as a replacement
  // character in every frame title.
  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="skill-atlas-hub">
  <diagram name="Skills" id="skills">
    <mxGraphModel dx="1400" dy="900" grid="0" gridSize="10" guides="1" tooltips="1"
                  connect="1" arrows="1" fold="1" page="1" pageScale="1"
                  pageWidth="1169" pageHeight="826" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
${cells.join("\n")}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
}

const byKey = Object.fromEntries(clean.map(r => [r.key, r]));

const document = {
  version: 1,
  // The inline route carries no collection at all any more.
  //
  // It was there to feed each shape's data panel, and Standard Import drops
  // linkedData silently, so it fed nothing. Every byte of it was wasted, and
  // it was most of the payload: 87KB became 28KB when the skill text came out,
  // and it drops again now. The detail lives in each shape's note instead.
  //
  // The file route keeps its collection because the .lucid/CSV pair is a
  // different mechanism and was never tested as broken.
  ...(INLINE ? {} : { collections: [{ id: "skills", dataSource: "skills.csv" }] }),
  pages: [{
    id: "atlas",
    title: "Skills",
    // Frames first so they paint behind their boxes. The header and legend sit
    // in empty space above everything, so their order does not matter.
    shapes: [...frames, ...shapes, ...legend, ...header],
    lines: [],
    ...(INLINE ? {} : { layers })
  }]
};

const json = JSON.stringify(document);
const jsonBytes = Buffer.byteLength(json, "utf8");
const dataBytes = INLINE ? 0 : Buffer.byteLength(data, "utf8");

const kb = n => Math.round(n / 1024) + "KB";
const who = `${skills.length} skills, ${people.length} ${people.length === 1 ? "person" : "people"}`;

if (DRAWIO) {
  const body = drawio();
  writeFileSync(OUT, body);
  console.log(`${who}, ${frames.length + shapes.length} shapes`);
  console.log(`${kb(Buffer.byteLength(body, "utf8"))} of draw.io XML`);
  console.log(`Wrote ${OUT}`);
  console.log("Import it in Lucid with File > Import, which accepts draw.io.");
} else {
  writeFileSync(OUT, INLINE ? json : zip([
    { name: "document.json", body: json },
    { name: "data/skills.csv", body: data }
  ]));

  console.log(who + (INLINE ? " (inline data, no layers)" : `, ${layers.length} discipline layers`));
  console.log(`document.json ${kb(jsonBytes)} of 2MB` +
              (INLINE ? "" : ` · data/skills.csv ${kb(dataBytes)} of 1MB`));
  if (droppedText) {
    console.log("Skill text left out: the hub is now too big to carry it inside the document.");
  }
  if (jsonBytes > MB * 2 || dataBytes > MB) {
    console.error("Over Lucid's size limit. The import will be refused.");
    process.exit(1);
  }
  console.log(`Wrote ${OUT}`);
  console.log("Standard Import goes in through the REST API only. There is no");
  console.log("File > Import for it. Without API write access, use --drawio.");
}
