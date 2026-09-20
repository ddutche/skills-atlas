#!/usr/bin/env node
/**
 * generate-atlas — build the browsable atlas from what people have published.
 *
 *   node tools/generate-atlas/generate-atlas.mjs [--hub <dir>] [--out <file>] [--check]
 *
 * Reads   skills/<person>/profile.json  and each authored skill's SKILL.md
 * Writes  the data block of atlas.html, between the @data markers
 *
 * Zero dependencies, single file, no network. It rewrites only the marked
 * region, so the presentation layer around it is never touched.
 *
 * Only people who publish ever run this. Nobody who just *reads* the atlas
 * needs Node, or needs to know this file exists.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const HUB = resolve(arg("--hub", process.cwd()));
const OUT = resolve(arg("--out", join(HUB, "atlas.html")));
const CHECK_ONLY = argv.includes("--check");

// Where to drop the parsed hub as plain JSON, for anything that needs the same
// reading of the same files without parsing them a second time. tools/lucid-export
// consumes this. One parser, several outputs, which is the only way the atlas
// and the Lucid document can be guaranteed to agree about what the hub holds.
const EMIT_INDEX = arg("--emit-index", "");

const problems = [];
const note = (where, msg) => problems.push(`${where}: ${msg}`);

// ---------------------------------------------------------------------------
// frontmatter
//
// Deliberately small. Handles the shapes a SKILL.md actually uses — flat
// scalars, folded (`>`) blocks, inline arrays, and comma lists — and ignores
// anything else rather than pulling in a YAML dependency.
// ---------------------------------------------------------------------------
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };

  const data = {};
  const lines = m[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value = rawValue.trim();

    // folded / literal block: consume the indented lines that follow
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        block.push(lines[++i].trim());
      }
      value = value.startsWith(">") ? block.join(" ") : block.join("\n");
    }

    value = value.replace(/^["']|["']$/g, "");

    if (/^\[.*\]$/.test(value)) {
      data[key] = value.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      data[key] = value;
    }
  }

  return { data, body: text.slice(m[0].length) };
}

// First sentence, for the one-line row description. Falls back to a hard
// truncation so a description written as one long clause still reads.
function firstSentence(text, max = 190) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const stop = clean.search(/\.\s|\.$/);
  const out = stop > 30 ? clean.slice(0, stop + 1) : clean;
  return out.length > max ? out.slice(0, max - 1).trimEnd() + "…" : out;
}

// "How it works" — an explicit `steps:` list wins; otherwise use the H2
// headings, which is what a well-written SKILL.md already structures itself by.
function deriveSteps(data, body) {
  if (Array.isArray(data.steps)) return data.steps;
  if (typeof data.steps === "string" && data.steps) {
    return data.steps.split(/;|•/).map(s => s.trim()).filter(Boolean);
  }
  const heads = [...body.matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1].trim());
  return heads.slice(0, 6);
}

function deriveTags(data) {
  if (Array.isArray(data.tags)) return data.tags.map(t => t.toLowerCase());
  if (typeof data.tags === "string" && data.tags) {
    return data.tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
  }
  return [];
}

const fmtDate = d => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

// Folder name -> display name. Sentence case, except for the acronyms that
// look wrong lowercased: "unslop-ui" should read "Unslop UI", not "Unslop ui".
const ACRONYMS = new Set([
  "ui", "ux", "api", "cli", "sdk", "mcp", "sql", "crm", "erp", "ap", "ar",
  "qbr", "kpi", "roi", "sow", "nda", "pdf", "csv", "json", "yaml", "html",
  "css", "http", "url", "id", "ai", "llm", "seo", "saas", "icp"
]);
const displayName = id => id
  .split(/[-_]+/)
  .filter(Boolean)
  .map((w, i) => ACRONYMS.has(w.toLowerCase())
    ? w.toUpperCase()
    : (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
  .join(" ");

// A bare "2026-08-02" parses as UTC midnight, which renders as the previous
// day for anyone west of it. Treat date-only strings as local.
function parseDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return new Date(value.trim() + "T00:00:00");
  }
  return new Date(value);
}

// Automatic discipline classification.
//
// Nobody tags their own skills. They forget, they disagree with each other, and
// the tags rot. So the discipline is inferred from the words the skill already
// uses. An author can override it in frontmatter (`discipline: ui-ux`) but is
// never asked to.
//
// These lists are also what makes searching "html" find a skill that only ever
// says "stylesheet" — the atlas expands a query to the disciplines whose
// vocabulary it belongs to.
const DISCIPLINE_SIGNALS = {
  "ui-ux": ["css", "html", "frontend", "front-end", "ui", "ux", "interface", "layout",
            "typography", "colour", "color", "palette", "component", "responsive",
            "styling", "visual", "design", "screen", "button", "spacing"],
  "engineering": ["test", "tests", "deploy", "deployment", "dependency", "dependencies",
                  "commit", "git", "api", "database", "refactor", "build", "compile",
                  "package", "npm", "lint", "regression", "pull request", "codebase"],
  "writing": ["changelog", "documentation", "docs", "readme", "summary", "draft",
              "copy", "prose", "narrative", "tone", "wording", "phrasing", "plain english",
              "plain language", "rewrite"],
  "data": ["query", "sql", "report", "dashboard", "metric", "metrics", "analysis",
           "analytics", "spreadsheet", "csv", "chart", "aggregate", "trend", "variance"],
  "machine-learning": ["model", "training", "embedding", "llm", "inference", "dataset",
                       "fine-tune", "classifier", "neural", "prompt"],
  "finance": ["invoice", "revenue", "margin", "forecast", "budget", "reconcile",
              "reconciliation", "tax", "payable", "receivable", "accounting", "cash flow",
              "close", "p&l"],
  "sales": ["prospect", "lead", "leads", "discovery", "pipeline", "quota", "objection",
            "demo", "renewal", "outreach", "qbr", "icp", "crm", "deal", "account executive",
            "churn", "buyer"],
  "security": ["credential", "credentials", "secret", "secrets", "vulnerability", "auth",
               "token", "api key", "encryption", "permission", "leak", "exploit", "cve"],
  "operations": ["workflow", "process", "onboarding", "ticket", "escalation", "runbook",
                 "handoff", "scheduling", "intake", "triage"]
};

// Words that mean one thing and one thing only. "git" and "commit" show up in
// half the skills here; "credential" and "typography" do not. Without this,
// a skill about leaked API keys classifies as engineering because it happens to
// mention commits a lot.
const STRONG_SIGNALS = {
  "ui-ux": ["css", "html", "typography", "ux", "interface", "responsive", "palette"],
  "engineering": ["refactor", "lint", "compile", "regression", "codebase", "pull request"],
  "writing": ["changelog", "prose", "tone", "plain english", "plain language", "wording"],
  "data": ["sql", "dashboard", "analytics", "spreadsheet"],
  "machine-learning": ["embedding", "fine-tune", "classifier", "neural", "llm"],
  "finance": ["invoice", "reconcile", "reconciliation", "payable", "receivable", "p&l"],
  "sales": ["prospect", "quota", "objection", "pipeline", "icp", "churn", "discovery", "renewal", "qbr"],
  "security": ["credential", "credentials", "secret", "secrets", "api key", "vulnerability", "leak"],
  "operations": ["runbook", "escalation", "triage", "handoff"]
};

function classify(text, explicit) {
  if (explicit && DISCIPLINE_SIGNALS[explicit]) return { discipline: explicit, terms: [] };

  const hay = " " + String(text || "").toLowerCase().replace(/[^a-z0-9&\s-]/g, " ").replace(/\s+/g, " ") + " ";
  const count = w => (hay.split(" " + w + " ").length - 1) + (hay.split(" " + w + "s ").length - 1);

  let best = "general", bestScore = 0;
  const terms = [];

  for (const [discipline, words] of Object.entries(DISCIPLINE_SIGNALS)) {
    const strong = new Set(STRONG_SIGNALS[discipline] || []);
    let score = 0;
    for (const w of words) {
      const hits = count(w);
      if (hits > 0) { score += hits * (strong.has(w) ? 3 : 1); terms.push(w); }
    }
    if (score > bestScore) { bestScore = score; best = discipline; }
  }

  // One stray keyword is not a theme. Below this it stays general purpose.
  return { discipline: bestScore >= 3 ? best : (explicit || "general"), terms: [...new Set(terms)] };
}

// A skill may ship an `about.md` — a plain-language overview written for a human
// deciding whether they want it, as opposed to the frontmatter `description`,
// which is written to help Claude decide when to load it and reads like it.
//
// First line becomes the one-liner in the list. The rest becomes the overview
// panel. Kept as a sidecar rather than frontmatter so external skills can have
// one without their SKILL.md being modified.
function readAbout(dir) {
  const p = join(dir, "about.md");
  if (!existsSync(p)) return null;

  const raw = readFileSync(p, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
  if (!raw) return null;

  const blocks = raw.split(/\r?\n\s*\r?\n/).map(b => b.trim()).filter(Boolean);
  const lead = blocks.shift().replace(/^#+\s*/, "").replace(/\s+/g, " ");

  const esc = t => t.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const html = blocks.map(b => {
    const lines = b.split(/\r?\n/).map(l => l.trim());
    if (lines.every(l => /^[-*]\s+/.test(l))) {
      return `<ul>${lines.map(l => `<li>${esc(l.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    return `<p>${esc(b.replace(/\s+/g, " "))}</p>`;
  }).join("");

  return { lead, html };
}

// A skill may ship a diagram.mmd: Mermaid source for a flowchart of how it
// works. The atlas draws it, so only the text is stored, never an image.
function readMmd(dir) {
  const p = join(dir, "diagram.mmd");
  if (!existsSync(p)) return "";
  const t = readFileSync(p, "utf8").trim();
  const first = t.split(String.fromCharCode(10))[0].trim().toLowerCase();
  const looksLikeFlowchart = first.startsWith('flowchart ') || first.startsWith('graph ');
  if (t && !looksLikeFlowchart) {
    note(p, "does not start with a flowchart/graph direction, so the atlas will show the source instead");
  }
  return t;
}

// A skill may ship a pre-rendered diagram.svg. It is inlined, so the atlas
// stays a single file with no external requests. Scripts are stripped — an
// SVG is a document here, not a program.
function readDiagram(dir) {
  const p = join(dir, "diagram.svg");
  if (!existsSync(p)) return null;
  const svg = readFileSync(p, "utf8");
  if (!/<svg[\s>]/i.test(svg)) { note(p, "not an SVG, ignored"); return null; }
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .trim();
}

const dirsIn = p => existsSync(p)
  ? readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
  : [];

// ---------------------------------------------------------------------------
// read the hub
// ---------------------------------------------------------------------------
const skillsRoot = join(HUB, "skills");
if (!existsSync(skillsRoot)) {
  console.error(`No skills/ directory under ${HUB}. Pass --hub with the hub folder.`);
  process.exit(1);
}

// Departments and disciplines live in hub.json so adding a team is one line
// there, not an edit across the generator, the atlas and the upload form.
let taxonomy = { departments: [], disciplines: [] };
const hubJson = join(HUB, "hub.json");
if (existsSync(hubJson)) {
  try {
    const parsed = JSON.parse(readFileSync(hubJson, "utf8"));
    taxonomy.departments = Array.isArray(parsed.departments) ? parsed.departments : [];
    taxonomy.disciplines = Array.isArray(parsed.disciplines) ? parsed.disciplines : [];
  } catch (e) {
    note("hub.json", `not valid JSON (${e.message}) — filters will be empty`);
  }
}
const knownDisciplines = new Set(taxonomy.disciplines.map(d => d.id));

// Canvas arrangements are per person and live in each profile.
const layouts = {};

// Match a free-text team against the canonical list so "solutions engineering"
// and "Solutions Engineering" land in the same filter.
function canonicalDepartment(team, personId) {
  const raw = String(team || "").trim();
  if (!raw) return "";
  const hit = taxonomy.departments.find(d => d.toLowerCase() === raw.toLowerCase());
  if (hit) return hit;
  note(`skills/${personId}/profile.json`, `team "${raw}" is not in hub.json departments — it will filter as its own group`);
  return raw;
}

const people = [];
const skills = [];
const refs = {};

for (const personId of dirsIn(skillsRoot)) {
  const personDir = join(skillsRoot, personId);
  const profilePath = join(personDir, "profile.json");

  let profile = {};
  if (existsSync(profilePath)) {
    try {
      profile = JSON.parse(readFileSync(profilePath, "utf8"));
    } catch (e) {
      note(`skills/${personId}/profile.json`, `not valid JSON (${e.message}) — section skipped`);
      continue;
    }
  } else {
    note(`skills/${personId}`, "no profile.json, using folder name");
  }

  const department = canonicalDepartment(profile.team, personId);
  if (profile.layout && typeof profile.layout === "object") layouts[personId] = profile.layout;

  people.push({
    id: personId,
    name: profile.display_name || personId,
    role: profile.team || "",
    dept: department
  });

  refs[personId] = {
    installed: Array.isArray(profile.installed)
      ? profile.installed.map(x => (typeof x === "string" ? x : x && x.skill)).filter(Boolean)
      : [],
    forked: Array.isArray(profile.forked)
      ? profile.forked.filter(f => f && f.skill && f.from).map(f => ({ id: f.skill, from: f.from }))
      : [],
  };

  // Skills someone found outside the company and published here. The file is a real
  // copy like any other — a source link can rot, and a stale copy that works
  // beats a dead link. `external` only records where it came from.
  const external = new Map();
  for (const e of Array.isArray(profile.external) ? profile.external : []) {
    if (!e || !e.skill) { note(`skills/${personId}/profile.json`, "an external entry has no skill name"); continue; }
    external.set(e.skill, e);
  }

  // authored skills are the directories that actually contain a SKILL.md
  for (const skillId of dirsIn(personDir)) {
    const skillDir = join(personDir, skillId);
    const skillMd = join(skillDir, "SKILL.md");
    if (!existsSync(skillMd)) continue;

    const raw = readFileSync(skillMd, "utf8");
    const { data, body } = parseFrontmatter(raw);

    if (!data.description) note(`skills/${personId}/${skillId}`, "no description in frontmatter");
    if (data.name && data.name !== skillId) {
      note(`skills/${personId}/${skillId}`, `frontmatter name is "${data.name}" — folder name wins`);
    }

    const updated = profile.updated_at ? parseDate(profile.updated_at) : statSync(skillMd).mtime;
    const ext = external.get(skillId);
    const about = readAbout(skillDir);
    if (!about) note(`skills/${personId}/${skillId}`, "no about.md — the overview will fall back to the frontmatter description, which reads like machine instructions");

    // Classify from everything the skill says about itself, not just its name.
    // An explicit choice wins: profile.json first (set by the upload form, and
    // usable for external skills whose SKILL.md must stay untouched), then the
    // skill's own frontmatter.
    const chosen = (profile.disciplines || {})[skillId] || data.discipline;
    const classified = classify(
      [skillId, data.description, about ? about.lead : "", body].join(" "),
      chosen && knownDisciplines.has(chosen) ? chosen : null
    );

    skills.push({
      id: skillId,
      name: data.title || displayName(skillId),
      author: personId,
      dept: department,
      discipline: classified.discipline,
      auto: classified.terms.slice(0, 24),
      kind: ext ? "external" : "authored",
      source: ext ? (ext.source || "external") : "",
      url: ext ? (ext.url || "") : "",
      captured: ext && ext.captured ? fmtDate(parseDate(ext.captured)) : "",
      why: ext && ext.why ? String(ext.why).trim() : "",
      tags: deriveTags(data),
      installs: 0,                       // filled in below
      updated: fmtDate(updated),
      updatedAt: +updated,
      desc: about ? firstSentence(about.lead) : firstSentence(data.description),
      about: about ? about.html : "",
      steps: about ? [] : deriveSteps(data, body),
      mmd: readMmd(skillDir),
      diagram: readDiagram(skillDir),
      src: raw.trimEnd()
    });
  }
}

// ---------------------------------------------------------------------------
// install counts — derived, never hand-maintained
// ---------------------------------------------------------------------------
const byKey = new Map(skills.map(s => [`${s.author}/${s.id}`, s]));
for (const [personId, r] of Object.entries(refs)) {
  for (const ref of r.installed) {
    const target = byKey.get(ref);
    if (target) target.installs++;
    else note(`skills/${personId}/profile.json`, `installed "${ref}" does not exist`);
  }
  for (const f of r.forked) {
    if (!byKey.has(`${personId}/${f.id}`)) {
      note(`skills/${personId}/profile.json`, `forked "${f.id}" is not an authored skill here`);
    }
  }
}

// most-installed first, then most recently updated
skills.sort((a, b) => b.installs - a.installs || b.updatedAt - a.updatedAt);
skills.forEach(s => delete s.updatedAt);
people.sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const tagCount = new Set(skills.flatMap(s => s.tags)).size;
const authoredCount = skills.filter(s => s.kind === "authored").length;
const externalCount = skills.length - authoredCount;
console.log(
  `${authoredCount} written here · ${externalCount} from outside · ` +
  `${people.length} people · ${tagCount} tags`
);
const undescribed = skills.filter(s => !s.desc).length;
if (undescribed) console.log(`${undescribed} skill(s) have no description and will look empty in the atlas`);
if (problems.length) {
  console.log(`\n${problems.length} thing(s) to look at:`);
  for (const p of problems) console.log(`  - ${p}`);
}

if (CHECK_ONLY) {
  console.log(`\n--check: nothing written.`);
  process.exit(problems.length ? 1 : 0);
}
if (!skills.length) {
  console.error(`\nNo skills found. Refusing to overwrite ${OUT} with an empty atlas.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// write the data block
// ---------------------------------------------------------------------------
const j = v => JSON.stringify(v);
const block = `
const UPDATED = ${j(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }))};

// The downloadable snapshot keeps every skill's text inline, because there is
// no server behind it to ask. The live page does the opposite.
const SRC_ON_DEMAND = false;

const DEPARTMENTS = ${j(taxonomy.departments)};

const LAYOUTS = ${j(layouts)};

const DISCIPLINES = ${j(taxonomy.disciplines)};

const DISCIPLINE_SIGNALS = ${j(DISCIPLINE_SIGNALS)};

const PEOPLE = [
${people.map(p => `  ${j(p)}`).join(",\n")}
];

const SKILLS = [
${skills.map(s => `  ${j(s)}`).join(",\n")}
];

const REFS = ${j(refs, null, 2).replace(/\n/g, "\n")};
`;

if (EMIT_INDEX) {
  writeFileSync(resolve(EMIT_INDEX), JSON.stringify({
    UPDATED: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
    DEPARTMENTS: taxonomy.departments,
    DISCIPLINES: taxonomy.disciplines,
    LAYOUTS: layouts,
    PEOPLE: people,
    SKILLS: skills,
    REFS: refs
  }, null, 1) + "\n", "utf8");
  console.log(`Index written to ${EMIT_INDEX}`);
}

const template = readFileSync(existsSync(OUT) ? OUT : join(HUB, "atlas.html"), "utf8");
const START = "/* @data:start */";
const END = "/* @data:end */";
const a = template.indexOf(START);
const b = template.indexOf(END);
if (a === -1 || b === -1 || b < a) {
  console.error(`Could not find the ${START} / ${END} markers in the template. Not writing.`);
  process.exit(1);
}

writeFileSync(OUT, template.slice(0, a + START.length) + block + template.slice(b), "utf8");
console.log(`\nWrote ${OUT}`);
