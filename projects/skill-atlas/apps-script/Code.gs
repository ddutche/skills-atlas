/**
 * Skill Atlas — live atlas.
 *
 * Serves the atlas by reading the Shared Drive folder on request, so it is
 * current the moment anyone adds a skill. Nothing to regenerate, nothing to
 * remember, no machine that has to be switched on.
 *
 * It does the same transformation as tools/generate-atlas/generate-atlas.mjs,
 * against the same atlas.html template and the same @data markers. The Node
 * version still exists for producing a downloadable offline snapshot. If you
 * change how a skill is read, change it in both — they are two runtimes doing
 * one job, and that is the one maintenance cost of this design.
 *
 * SETUP — see DEPLOY.md. You only need to set HUB_FOLDER_ID below.
 */

// The Drive folder containing hub.json, atlas.html, skills/ and tools/.
//
// This is the ONE value you must set. Take it from the folder's URL, the part
// after /folders/:  https://drive.google.com/drive/folders/THIS_PART
//
// It was pre-filled in the original deployment, deliberately, because repasting
// this file kept wiping whoever had set it and the resulting failure
// ("getFolderById" throwing) reads like a broken script rather than an
// unconfigured one. That id pointed at one specific company's Shared Drive and
// does not travel, so it is blank here and the check below says so plainly.
const HUB_FOLDER_ID = '';

// What the browser tab and the page header say. Set it to whatever the hub is
// called where you are running it.
const HUB_NAME = 'Skill Atlas';

if (!HUB_FOLDER_ID) {
  // Deliberately not thrown at load time: Apps Script runs this file for every
  // trigger and menu action too, and a top-level throw would make an
  // unconfigured project look broken everywhere at once rather than in the one
  // place that needs fixing. doGet reports it as a readable page instead.
}

// How long a built page is reused before the folder is read again.
//
// Half an hour rather than five minutes, because every write the page makes
// clears this cache itself. So publishing or saving an arrangement shows up
// immediately regardless; the only thing that lags is someone editing files in
// Drive by hand, and ?refresh=1 covers that.
const CACHE_SECONDS = 1800;

// Where the built data block is kept between requests. Deleted by every write,
// rebuilt by the next reader. A cold visit costs two file reads rather than one
// per file in the hub.
const INDEX_FILE = 'index.json';

// Bumped by every write that changes what the atlas shows. The page polls it
// so a skill someone publishes appears for everyone else without a reload.
//
// It lives in script properties rather than the cache because the cache can be
// evicted at any moment, and a stamp that silently resets would make every open
// page think the hub had changed and redraw itself.
const VERSION_KEY = 'hubVersion';

function currentVersion() {
  try {
    const v = PropertiesService.getScriptProperties().getProperty(VERSION_KEY);
    return v ? parseInt(v, 10) || 0 : 0;
  } catch (err) { return 0; }
}

function bumpVersion() {
  try {
    const props = PropertiesService.getScriptProperties();
    const next = currentVersion() + 1;
    props.setProperty(VERSION_KEY, String(next));
    return next;
  } catch (err) { return 0; }
}

/**
 * What the page polls. Deliberately the cheapest call in the file: one
 * properties read, no Drive access at all, so checking every half minute across
 * a whole company costs effectively nothing.
 */
function getStamp() {
  const out = { version: currentVersion() };
  // Carried on the poll so a hub that has quietly lost its index reports it
  // rather than just feeling slow. Costs one more properties read on a call
  // that already does one.
  try {
    const failed = PropertiesService.getScriptProperties().getProperty(INDEX_WRITE_FAILED);
    if (failed) out.indexWriteFailed = failed;
  } catch (err) { /* the version is the part that matters */ }
  return out;
}

/**
 * The current index, for a page bringing itself up to date without a reload.
 *
 * Returns the same structures the page was built from, so refreshing in place
 * and loading fresh cannot disagree about what the hub contains.
 */
function getData() {
  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  return { ok: true, version: currentVersion(), data: getIndex(hub) };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------
function doGet(e) {
  // The one setup mistake worth catching by name. Without this, an unset id
  // surfaces as "Invalid argument: id" from getFolderById, which sends people
  // hunting for a permissions problem that is not there.
  if (!HUB_FOLDER_ID) {
    return HtmlService.createHtmlOutput(errorPage(new Error(
      'HUB_FOLDER_ID is not set. Open Code.gs and set it to your hub folder id, ' +
      'the part of the folder URL after /folders/.'
    ))).setTitle(HUB_NAME);
  }

  const refresh = e && e.parameter && e.parameter.refresh;
  if (refresh) bustCache();
  let html = refresh ? null : cacheGet('atlas');

  if (!html) {
    try {
      html = buildPage();
      cachePut('atlas', html, CACHE_SECONDS);
    } catch (err) {
      html = errorPage(err);
    }
  }

  return HtmlService.createHtmlOutput(html)
    .setTitle(HUB_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function buildPage() {
  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  const template = readText(hub, 'atlas.html');
  if (!template) throw new Error('No atlas.html in the hub folder.');

  const START = '/* @data:start */';
  const END = '/* @data:end */';
  const a = template.indexOf(START);
  const b = template.indexOf(END);
  if (a === -1 || b === -1 || b < a) {
    throw new Error('atlas.html is missing its @data markers.');
  }

  return template.slice(0, a + START.length) + getDataBlock(hub) + template.slice(b);
}

/**
 * The built data block, cached as a file in the hub.
 *
 * Rebuilding means reading every file in the Drive, which is roughly two
 * operations per skill. That is a couple of seconds at ten skills and over a
 * minute at two hundred. So it is done once and kept: `index.json` holds the
 * result, and every write path already calls bustCache(), which throws it away.
 *
 * The consequence: a cold load is two file reads instead of hundreds, and a
 * full rebuild only happens after something actually changed.
 *
 * Editing files in Drive by hand does not invalidate it, since nothing tells us.
 * Add ?refresh=1 to force a rebuild in that case.
 */
function getIndex(hub) {
  const cached = readText(hub, INDEX_FILE);
  if (cached) {
    try { return JSON.parse(cached); } catch (err) { /* fall through and rebuild */ }
  }

  const built = buildDataObject(hub);

  // Retry rather than give up on the first refusal. A burst of writes to a
  // Shared Drive intermittently comes back as "Access denied: DriveApp" with
  // permissions perfectly fine, and this write lands right after a rebuild has
  // just read several hundred files, which is exactly when that happens.
  //
  // The old version used plain writeText inside a try/catch that only logged.
  // One unlucky refusal therefore meant no index.json, and no index.json means
  // the NEXT visitor rebuilds and tries to write it in the same unlucky spot.
  // That failure mode is stable, silent, and looks exactly like "the site is
  // slow" — which is how the hub was found on 11 August 2026 with no index.json
  // in it at all, every single page load paying a full rebuild.
  try {
    writeTextResilient(hub, INDEX_FILE, JSON.stringify(built), 'application/json');
    PropertiesService.getScriptProperties().deleteProperty(INDEX_WRITE_FAILED);
  } catch (err) {
    // Serving still matters more than caching, so this does not throw. But it
    // no longer disappears either: the stamp records it, so "why is it slow"
    // has an answer that does not require reading the execution log.
    const msg = (err && err.message) || String(err);
    Logger.log('Could not cache the index: ' + msg);
    try {
      PropertiesService.getScriptProperties()
        .setProperty(INDEX_WRITE_FAILED, new Date().toISOString() + ' ' + msg);
    } catch (err2) { /* nothing left to try */ }
  }
  return built;
}

// Set when the index cannot be written, cleared when it can. Surfaced by
// getStamp so the condition is visible instead of only slow.
const INDEX_WRITE_FAILED = 'indexWriteFailed';

function getDataBlock(hub) {
  return renderDataBlock(getIndex(hub));
}

/**
 * The index rendered as the JavaScript spliced between the @data markers.
 *
 * Kept identical in shape to what tools/generate-atlas/generate-atlas.mjs emits,
 * because the page is written against these names and nothing else.
 */
function renderDataBlock(d) {
  const NL2 = NL + NL;
  return NL +
    'const UPDATED = ' + JSON.stringify(d.UPDATED) + ';' + NL2 +
    'const SRC_ON_DEMAND = true;' + NL2 +
    'const DEPARTMENTS = ' + JSON.stringify(d.DEPARTMENTS) + ';' + NL2 +
    'const LAYOUTS = ' + JSON.stringify(d.LAYOUTS || {}) + ';' + NL2 +
    'const DISCIPLINES = ' + JSON.stringify(d.DISCIPLINES) + ';' + NL2 +
    'const DISCIPLINE_SIGNALS = ' + JSON.stringify(DISCIPLINE_SIGNALS) + ';' + NL2 +
    'const PEOPLE = ' + JSON.stringify(d.PEOPLE) + ';' + NL2 +
    'const SKILLS = ' + JSON.stringify(d.SKILLS) + ';' + NL2 +
    'const REFS = ' + JSON.stringify(d.REFS) + ';' + NL;
}

// ---------------------------------------------------------------------------
// read the hub
// ---------------------------------------------------------------------------
function buildDataObject(hub) {
  const skillsRoot = getFolder(hub, 'skills');
  if (!skillsRoot) throw new Error('No skills/ folder in the hub.');

  // Departments and disciplines are edited in hub.json and nowhere else.
  let taxonomy = { departments: [], disciplines: [] };
  const hubText = readText(hub, 'hub.json');
  if (hubText) {
    try {
      const parsed = JSON.parse(hubText);
      taxonomy.departments = parsed.departments || [];
      taxonomy.disciplines = parsed.disciplines || [];
    } catch (err) { /* filters stay empty rather than the page failing */ }
  }
  const knownDisciplines = {};
  taxonomy.disciplines.forEach(function (d) { knownDisciplines[d.id] = true; });

  // Canvas arrangements are deliberately NOT collected here. They belong to one
  // person, they change every time anybody nudges a box, and putting them in
  // this index meant every drag invalidated it and made the next visitor wait
  // for a full rebuild. whoAmI hands each person their own arrangement instead.
  const layouts = {};

  function canonicalDepartment(team) {
    const raw = String(team || '').replace(/^\s+|\s+$/g, '');
    if (!raw) return '';
    for (let i = 0; i < taxonomy.departments.length; i++) {
      if (taxonomy.departments[i].toLowerCase() === raw.toLowerCase()) return taxonomy.departments[i];
    }
    return raw;
  }

  const people = [];
  const skills = [];
  const refs = {};

  // email -> folder, so signing someone in is a lookup rather than a scan of
  // every profile in the hub. Stays in index.json and is never rendered into
  // the page: the addresses are in the Drive already, but that is no reason to
  // publish them in the HTML.
  const emails = {};

  const personFolders = skillsRoot.getFolders();
  while (personFolders.hasNext()) {
    const personFolder = personFolders.next();
    const personId = personFolder.getName();

    let profile = {};
    const profileText = readText(personFolder, 'profile.json');
    if (profileText) {
      try {
        profile = JSON.parse(profileText);
      } catch (err) {
        continue;   // one malformed file must not take down everyone's atlas
      }
    }

    const department = canonicalDepartment(profile.team);
    if (profile.email) emails[String(profile.email).toLowerCase()] = personId;

    people.push({
      id: personId,
      name: profile.display_name || personId,
      role: profile.team || '',
      dept: department
    });

    refs[personId] = {
      installed: (profile.installed || [])
        .map(function (x) { return typeof x === 'string' ? x : (x && x.skill); })
        .filter(function (x) { return !!x; }),
      forked: (profile.forked || [])
        .filter(function (f) { return f && f.skill && f.from; })
        .map(function (f) { return { id: f.skill, from: f.from }; })
    };

    const external = {};
    (profile.external || []).forEach(function (x) {
      if (x && x.skill) external[x.skill] = x;
    });

    const updated = profile.updated_at ? parseDate(profile.updated_at) : new Date();

    const skillFolders = personFolder.getFolders();
    while (skillFolders.hasNext()) {
      const skillFolder = skillFolders.next();
      const skillId = skillFolder.getName();

      // One listing per skill folder, then download only what is actually
      // there. Asking for each filename separately costs a round trip even when
      // the file does not exist, and most skills have no diagram — that alone
      // was two thirds of the page load.
      const files = readFolderFiles(skillFolder,
        ['SKILL.md', 'about.md', 'diagram.svg', 'diagram.mmd']);

      const raw = files['SKILL.md'];
      if (!raw) continue;                       // not a skill, skip quietly

      const fm = parseFrontmatter(raw);
      const about = parseAbout(files['about.md']);
      const ext = external[skillId];
      const diagram = sanitizeSvg(files['diagram.svg']);
      const mmd = (files['diagram.mmd'] || '').replace(/^\s+|\s+$/g, '');

      const chosen = (profile.disciplines || {})[skillId] || fm.data.discipline;
      const classified = classify(
        [skillId, fm.data.description, about ? about.lead : '', fm.body].join(' '),
        chosen && knownDisciplines[chosen] ? chosen : null
      );

      skills.push({
        id: skillId,
        name: fm.data.title || displayName(skillId),
        author: personId,
        dept: department,
        discipline: classified.discipline,
        auto: classified.terms.slice(0, 24),
        kind: ext ? 'external' : 'authored',
        source: ext ? (ext.source || 'external') : '',
        url: ext ? (ext.url || '') : '',
        captured: ext && ext.captured ? fmtDate(parseDate(ext.captured)) : '',
        why: ext && ext.why ? String(ext.why).trim() : '',
        tags: deriveTags(fm.data),
        installs: 0,
        updated: fmtDate(updated),
        updatedAt: updated.getTime(),
        desc: firstSentence(about ? about.lead : fm.data.description),
        about: about ? about.html : '',
        steps: about ? [] : deriveSteps(fm.data, fm.body),
        mmd: mmd,
        diagram: diagram,
        // Deliberately empty: the page asks for a skill's text when someone
        // opens it. Shipping every one inflates the page by roughly 9KB apiece
        // for text almost nobody reads.
        src: ''
      });
    }
  }

  // install counts, derived — never hand-maintained
  const byKey = {};
  skills.forEach(function (s) { byKey[s.author + '/' + s.id] = s; });
  Object.keys(refs).forEach(function (pid) {
    refs[pid].installed.forEach(function (ref) {
      if (byKey[ref]) byKey[ref].installs++;
    });
  });

  skills.sort(function (x, y) { return y.installs - x.installs || y.updatedAt - x.updatedAt; });
  skills.forEach(function (s) { delete s.updatedAt; });
  people.sort(function (x, y) { return x.name < y.name ? -1 : x.name > y.name ? 1 : 0; });

  return {
    EMAILS: emails,
    UPDATED: fmtDate(new Date()) + ' ' + new Date().getFullYear(),
    DEPARTMENTS: taxonomy.departments,
    LAYOUTS: layouts,
    DISCIPLINES: taxonomy.disciplines,
    PEOPLE: people,
    SKILLS: skills,
    REFS: refs
  };
}

// ---------------------------------------------------------------------------
// parsing — kept deliberately close to the Node version
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
    let value = kv[2].trim();

    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = value.charAt(0) === '>' ? block.join(' ') : block.join('\n');
    }

    value = value.replace(/^["']|["']$/g, '');

    if (/^\[.*\]$/.test(value)) {
      data[kv[1]] = value.slice(1, -1).split(',')
        .map(function (s) { return s.trim().replace(/^["']|["']$/g, ''); })
        .filter(function (s) { return !!s; });
    } else {
      data[kv[1]] = value;
    }
  }

  return { data: data, body: text.slice(m[0].length) };
}

// Automatic discipline classification. Kept identical to the Node generator —
// see the note at the top of this file about keeping the two in step.
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

  const hay = ' ' + String(text || '').toLowerCase()
    .replace(/[^a-z0-9&\s-]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const count = function (w) {
    return (hay.split(' ' + w + ' ').length - 1) + (hay.split(' ' + w + 's ').length - 1);
  };

  let best = 'general', bestScore = 0;
  const terms = [];

  for (const discipline in DISCIPLINE_SIGNALS) {
    const strong = STRONG_SIGNALS[discipline] || [];
    let score = 0;
    DISCIPLINE_SIGNALS[discipline].forEach(function (w) {
      const hits = count(w);
      if (hits > 0) { score += hits * (strong.indexOf(w) !== -1 ? 3 : 1); terms.push(w); }
    });
    if (score > bestScore) { bestScore = score; best = discipline; }
  }

  const uniq = [];
  terms.forEach(function (t) { if (uniq.indexOf(t) === -1) uniq.push(t); });
  return { discipline: bestScore >= 3 ? best : (explicit || 'general'), terms: uniq };
}

function parseAbout(raw) {
  if (!raw) return null;
  const text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/^\s+|\s+$/g, '');
  if (!text) return null;

  const blocks = text.split(/\r?\n\s*\r?\n/)
    .map(function (b) { return b.replace(/^\s+|\s+$/g, ''); })
    .filter(function (b) { return !!b; });

  const lead = blocks.shift().replace(/^#+\s*/, '').replace(/\s+/g, ' ');

  const html = blocks.map(function (b) {
    const lines = b.split(/\r?\n/).map(function (l) { return l.replace(/^\s+|\s+$/g, ''); });
    const allBullets = lines.every(function (l) { return /^[-*]\s+/.test(l); });
    if (allBullets) {
      return '<ul>' + lines.map(function (l) {
        return '<li>' + escHtml(l.replace(/^[-*]\s+/, '')) + '</li>';
      }).join('') + '</ul>';
    }
    return '<p>' + escHtml(b.replace(/\s+/g, ' ')) + '</p>';
  }).join('');

  return { lead: lead, html: html };
}

function deriveSteps(data, body) {
  if (Object.prototype.toString.call(data.steps) === '[object Array]') return data.steps;
  if (typeof data.steps === 'string' && data.steps) {
    return data.steps.split(/;|•/)
      .map(function (s) { return s.replace(/^\s+|\s+$/g, ''); })
      .filter(function (s) { return !!s; });
  }
  const heads = [];
  const re = /^##\s+(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(body)) !== null) heads.push(m[1]);
  return heads.slice(0, 6);
}

function deriveTags(data) {
  if (Object.prototype.toString.call(data.tags) === '[object Array]') {
    return data.tags.map(function (t) { return String(t).toLowerCase(); });
  }
  if (typeof data.tags === 'string' && data.tags) {
    return data.tags.split(',')
      .map(function (t) { return t.replace(/^\s+|\s+$/g, '').toLowerCase(); })
      .filter(function (t) { return !!t; });
  }
  return [];
}

function firstSentence(text, max) {
  max = max || 190;
  const clean = String(text || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  if (!clean) return '';
  const stop = clean.search(/\.\s|\.$/);
  const out = stop > 30 ? clean.slice(0, stop + 1) : clean;
  return out.length > max ? out.slice(0, max - 1).replace(/\s+$/, '') + '…' : out;
}

const ACRONYMS = {
  ui: 1, ux: 1, api: 1, cli: 1, sdk: 1, mcp: 1, sql: 1, crm: 1, erp: 1, ap: 1,
  ar: 1, qbr: 1, kpi: 1, roi: 1, sow: 1, nda: 1, pdf: 1, csv: 1, json: 1,
  yaml: 1, html: 1, css: 1, http: 1, url: 1, id: 1, ai: 1, llm: 1, seo: 1,
  saas: 1, icp: 1
};

function displayName(id) {
  return id.split(/[-_]+/).filter(function (w) { return !!w; })
    .map(function (w, i) {
      if (ACRONYMS[w.toLowerCase()]) return w.toUpperCase();
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    }).join(' ');
}

function sanitizeSvg(svg) {
  if (!svg || !/<svg[\s>]/i.test(svg)) return null;
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/^\s+|\s+$/g, '');
}

function escHtml(t) {
  return String(t).replace(/[&<>]/g, function (c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
  });
}

// A bare "2026-08-02" is parsed as UTC and renders as the previous day west of
// it. Build it as a local date instead.
function parseDate(value) {
  if (value instanceof Date) return value;
  const s = String(value).replace(/^\s+|\s+$/g, '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(d) { return d.getDate() + ' ' + MONTHS[d.getMonth()]; }

// ---------------------------------------------------------------------------
// Writes
//
// The page calls these with google.script.run, so there is no CORS and no
// separate endpoint to secure. Anyone who can open the atlas can call them,
// which is exactly the set of people who can already edit the Drive folder, so
// the checks below are about preventing accidents and malformed data rather
// than about keeping colleagues out.
//
// Drive keeps version history on every file these touch, so a bad write is
// recoverable from the file's own revision list.
// ---------------------------------------------------------------------------

const MAX_LAYOUT_ENTRIES = 2000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Built rather than written as an escape. Several rounds of tooling in this
// project have turned "\n" into a real newline mid-string; this cannot.
const NL = String.fromCharCode(10);

/**
 * Saves the caller's own canvas arrangement into their profile.
 *
 * Per person rather than shared: moving a box should not rearrange the board
 * for the whole company, but it should follow you to another machine. Called
 * automatically after a drag, so there is no save button to forget.
 */
function saveLayout(positions) {
  const me = whoAmI();
  if (!me.known) return { ok: false, message: 'Not signed in, so this was not saved.' };
  if (!positions || typeof positions !== 'object') {
    return { ok: false, message: 'Nothing to save.' };
  }

  const clean = {};
  let n = 0;
  for (const k in positions) {
    if (n >= MAX_LAYOUT_ENTRIES) break;
    const parts = String(k).split('/');
    // keys are always author/skill, and both halves are folder names
    if (parts.length !== 2 || !ID_RE.test(parts[0]) || !ID_RE.test(parts[1])) continue;
    const p = positions[k];
    if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
    if (Math.abs(p.x) > 200000 || Math.abs(p.y) > 200000) continue;
    clean[k] = { x: Math.round(p.x), y: Math.round(p.y) };
    n++;
  }

  if (!n) return { ok: false, message: 'Nothing valid to save.' };

  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  const mine = folderFor(folderFor(hub, 'skills'), me.person);

  let profile = {};
  const existing = readText(mine, 'profile.json');
  if (existing) { try { profile = JSON.parse(existing) || {}; } catch (err) { profile = {}; } }

  profile.email = me.email;
  profile.display_name = profile.display_name || me.display_name || me.person;
  profile.installed = profile.installed || [];
  profile.forked = profile.forked || [];
  profile.external = profile.external || [];
  profile.layout = clean;
  profile.updated_at = today();

  writeText(mine, 'profile.json', JSON.stringify(profile, null, 2) + NL, 'application/json');

  // No bustCache here on purpose. An arrangement is yours alone and is served
  // by whoAmI, not by the index, so moving boxes around costs nobody else a
  // rebuild. This was the single biggest cause of slow page loads.
  return { ok: true, message: 'Arrangement saved.', count: n };
}

const MAX_SKILLS_PER_PUBLISH = 120;
const MAX_FILE_CHARS = 400000;

/**
 * Publishes a whole set of skills for one person in a single call, so nobody
 * has to repeat an upload flow twenty times. Writes only inside that person's
 * own folder.
 */
function publishSkills(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, message: 'Nothing to publish.' };

  // When we know who is asking, that wins: nobody can publish into someone
  // else's folder by typing their name, and nobody has to type their own.
  const me = whoAmI();
  const person = me.known ? me.person : String(payload.person || '').trim();
  if (!ID_RE.test(person)) {
    return { ok: false, message: 'That name would not make a valid folder. Letters, numbers, dots and dashes only.' };
  }

  const incoming = Array.isArray(payload.skills) ? payload.skills : [];
  if (!incoming.length) return { ok: false, message: 'No skills selected.' };
  if (incoming.length > MAX_SKILLS_PER_PUBLISH) {
    return { ok: false, message: 'That is more than ' + MAX_SKILLS_PER_PUBLISH + ' skills in one go. Split it up.' };
  }

  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  const skillsRoot = folderFor(hub, 'skills');
  const mine = folderFor(skillsRoot, person);

  const external = [];
  const disciplines = {};
  const written = [];
  const skipped = [];

  for (let i = 0; i < incoming.length; i++) {
    const s = incoming[i] || {};
    const id = String(s.id || '').trim();
    const body = String(s.skillMd || '');

    if (!ID_RE.test(id)) { skipped.push((id || '(unnamed)') + ': not a valid folder name'); continue; }
    if (!body) { skipped.push(id + ': empty'); continue; }
    if (body.length > MAX_FILE_CHARS) { skipped.push(id + ': too large'); continue; }

    const dir = folderFor(mine, id);
    writeText(dir, 'SKILL.md', body, 'text/markdown');

    const about = String(s.about || '').trim();
    if (about) writeText(dir, 'about.md', about + '\n', 'text/markdown');

    const mmd = String(s.mmd || '').trim();
    if (mmd) writeText(dir, 'diagram.mmd', mmd + '\n', 'text/plain');

    if (s.kind === 'external') {
      const e = { skill: id, source: String(s.source || 'external').slice(0, 80), captured: today() };
      if (s.url) e.url = String(s.url).slice(0, 500);
      if (s.why) e.why = String(s.why).slice(0, 600);
      external.push(e);
    }
    if (s.discipline) disciplines[id] = String(s.discipline).slice(0, 40);

    written.push(id);
  }

  if (!written.length) {
    return { ok: false, message: 'Nothing could be published.', skipped: skipped };
  }

  // Merge into any existing profile rather than replacing it, so republishing
  // does not wipe what someone has installed from colleagues.
  let profile = {};
  const existing = readText(mine, 'profile.json');
  if (existing) { try { profile = JSON.parse(existing) || {}; } catch (err) { profile = {}; } }

  if (me.known) profile.email = me.email;
  profile.display_name = String(payload.display_name || profile.display_name || me.display_name || person).slice(0, 120);
  if (payload.team) profile.team = String(payload.team).slice(0, 120);
  profile.installed = profile.installed || [];
  profile.forked = profile.forked || [];

  const keepExternal = (profile.external || []).filter(function (e) {
    return e && written.indexOf(e.skill) === -1;
  });
  profile.external = keepExternal.concat(external);

  profile.disciplines = profile.disciplines || {};
  for (const k in disciplines) profile.disciplines[k] = disciplines[k];

  profile.updated_at = today();
  writeText(mine, 'profile.json', JSON.stringify(profile, null, 2) + '\n', 'application/json');

  bustCache();
  return {
    ok: true,
    message: 'Published ' + written.length + ' skill' + (written.length === 1 ? '' : 's') + '.',
    written: written,
    skipped: skipped,
    person: person,
    version: currentVersion()
  };
}

/**
 * Removes one of your own skills from the hub.
 *
 * Two rules, both enforced here rather than in the page, because the page is
 * just a convenience and anyone can call this directly:
 *
 *   1. We have to know who is asking. Under "Execute as: Me" nobody but the
 *      deployer is identifiable, so nobody else can delete anything.
 *   2. The skill has to be in your own folder. There is no borrowing someone
 *      else's, no admin override, and no way to phrase the key that gets around
 *      it, because the folder name is compared, not a name that was typed.
 *
 * The folder goes to the Drive trash rather than being destroyed, so a mistake
 * is recoverable for thirty days by whoever manages the Shared Drive.
 */
function deleteSkill(skillKey) {
  const me = whoAmI();
  if (!me.known) {
    return { ok: false, message: 'We cannot tell who you are, so nothing was deleted.' };
  }

  const parts = String(skillKey || '').split('/');
  if (parts.length !== 2 || !ID_RE.test(parts[0]) || !ID_RE.test(parts[1])) {
    return { ok: false, message: 'That is not a skill.' };
  }
  if (parts[0] !== me.person) {
    return { ok: false, message: 'That skill belongs to someone else. You can only delete your own.' };
  }

  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  const skillsRoot = getFolder(hub, 'skills');
  const mine = skillsRoot && getFolder(skillsRoot, me.person);
  const dir = mine && getFolder(mine, parts[1]);
  if (!dir) return { ok: false, message: 'That skill is not in the hub any more.' };

  dir.setTrashed(true);

  // The profile keeps notes about a skill in two places. Leaving either behind
  // would make a deleted skill reappear as a discipline tag on nothing, or as
  // an "external" entry pointing at a folder that no longer exists.
  const profileText = readText(mine, 'profile.json');
  if (profileText) {
    try {
      const profile = JSON.parse(profileText) || {};
      if (profile.disciplines) delete profile.disciplines[parts[1]];
      if (Array.isArray(profile.external)) {
        profile.external = profile.external.filter(function (e) {
          return !e || e.skill !== parts[1];
        });
      }
      if (profile.layout) delete profile.layout[skillKey];
      profile.updated_at = today();
      writeText(mine, 'profile.json', JSON.stringify(profile, null, 2) + NL, 'application/json');
    } catch (err) { /* the folder is gone either way, which is the point */ }
  }

  bustCache();
  return { ok: true, message: 'Deleted.', version: currentVersion() };
}

function today() {
  const d = new Date();
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * One-off updater. Drop `skill-atlas.zip` into the hub folder, then run this
 * from the Apps Script editor (select installFromZip, press Run).
 *
 * It unpacks the zip over the hub, updating each file in place and creating
 * folders as needed. Nothing is deleted: files the zip does not mention are left
 * alone, so a partial zip cannot wipe anyone's published skills.
 *
 * This exists because uploading through most Drive integrations *adds* a second
 * file with the same name rather than replacing the first, which quietly makes
 * every by-name lookup ambiguous. Apps Script can update in place, so this is
 * the safe way to push a new build.
 */
function installFromZip() {
  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);

  const it = hub.getFilesByName('skill-atlas.zip');
  if (!it.hasNext()) {
    throw new Error('No skill-atlas.zip in the hub folder. Drop it in, then run this again.');
  }

  const res = unpackInto(hub, it.next().getBlob());
  bustCache();

  const summary = 'Updated ' + res.written.length + ' file(s).' +
    (res.skipped.length ? ' Skipped: ' + res.skipped.join(', ') : '') +
    (res.failed.length ? ' Did not land, run this again: ' + res.failed.join(', ') : '');
  Logger.log(summary);
  Logger.log(res.written.join('\n'));
  return summary;
}

/**
 * A write that survives a Drive refusal that is not really a refusal.
 *
 * A burst of writes to a Shared Drive intermittently comes back as
 * "Access denied: DriveApp" with permissions perfectly fine. It clears by
 * itself in a second or two, so one pause and one retry turns a failed install
 * into a slightly slower one. If it fails twice it is probably real, and the
 * caller records it and moves on to the next file.
 */
function writeTextResilient(dir, name, body, mime) {
  try {
    writeText(dir, name, body, mime);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (msg.indexOf(NOT_A_TEXT_FILE) !== -1) throw err;   // a pause will not help
    Utilities.sleep(1500);
    writeText(dir, name, body, mime);
  }
}

/**
 * Names at the top of the hub that an update may never write.
 *
 * `Code.gs` is the live Apps Script project. It is a Google file with no text
 * body, so writing over it fails, and it is the one file in here that must be
 * changed by pasting into the script editor. A build that carried its own copy
 * of Code.gs at the root used to jam on this every single time.
 *
 * `skill-atlas.zip` is a package sitting in the hub, not part of the hub.
 */
function isReserved(path) {
  return path === 'Code.gs' || path === 'skill-atlas.zip';
}

/**
 * Applies a zip over the hub. Shared by the manual installer and the automatic
 * update trigger, so there is one unpacking implementation rather than two that
 * drift apart.
 */
function unpackInto(hub, zipBlob) {
  const entries = Utilities.unzip(zipBlob);
  const written = [];
  const skipped = [];
  const failed = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    let path = entry.getName();

    // Zips built on Windows can use backslashes as the separator even though the
    // spec says forward slash. Normalise before anything else, or every file
    // lands flat in the root with its whole path as its name.
    path = path.replace(/\\/g, '/');

    // Zips made from the folder carry a top-level "skill-atlas/" prefix.
    path = path.replace(/^skill-atlas\//, '');
    if (!path || path.slice(-1) === '/') continue;   // directory entry
    if (path.indexOf('..') !== -1) { skipped.push(path + ' (suspicious path)'); continue; }
    if (isReserved(path)) continue;

    const parts = path.split('/');
    const name = parts.pop();
    let dir = hub;
    for (let j = 0; j < parts.length; j++) dir = folderFor(dir, parts[j]);

    // One file failing must not abandon the rest. A burst of writes to a Shared
    // Drive surfaces as an access error, which used to abort the run and leave
    // the hub half-updated — worse than either finishing or not starting.
    // Failures are recorded and picked up by the next run instead.
    try {
      writeTextResilient(dir, name, entry.getDataAsString('UTF-8'), mimeFor(name));
      written.push(path);
    } catch (err) {
      failed.push(path + ' (' + (err && err.message ? err.message : err) + ')');
    }
  }

  return { written: written, skipped: skipped, failed: failed };
}

/**
 * Applies any `update-*.zip` sitting in the hub, oldest first, then trashes it.
 *
 * This is how a new build arrives without anyone pressing anything. Whoever is
 * shipping changes uploads a uniquely named zip and this picks it up within a
 * few minutes. The unique name matters: most Drive integrations cannot replace
 * a file, only add one, so a fixed name would pile up duplicates.
 *
 * Anyone who can write to the hub can drop an update zip. That is the same
 * trust level as editing the folder directly, so it is not a new hole, but it
 * is worth knowing it exists.
 */
function installUpdates() {
  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);

  const pending = [];
  const it = hub.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (/^update-.*\.(zip|json)$/i.test(f.getName())) pending.push(f);
  }
  if (!pending.length) return 'No updates waiting.';

  // Names carry a timestamp, so alphabetical order is chronological order.
  pending.sort(function (a, b) { return a.getName() < b.getName() ? -1 : 1; });

  const done = [];
  const stuck = [];
  for (let i = 0; i < pending.length; i++) {
    const f = pending[i];
    try {
      const res = /\.json$/i.test(f.getName())
        ? applyManifest(hub, f.getBlob().getDataAsString('UTF-8'))
        : unpackInto(hub, f.getBlob());

      if (res.failed && res.failed.length) {
        // Partly applied. Keep the file so the next run finishes the job, and
        // say exactly what is missing rather than reporting a flat failure on
        // an update that mostly worked.
        Logger.log('Partly applied ' + f.getName() + ': ' + res.failed.join('; '));
        stuck.push(f.getName() + ' - ' + res.written.length + ' written, ' +
                   res.failed.length + ' still to do: ' + res.failed.join('; '));
        continue;
      }

      done.push(f.getName() + ' (' + res.written.length + ' files)');
      // Cleanup failing must not make a good install look broken.
      try { f.setTrashed(true); } catch (err2) {
        stuck.push(f.getName() + ' installed, but could not be removed - delete it by hand');
      }
    } catch (err) {
      Logger.log('Failed on ' + f.getName() + ': ' + err.message);
      stuck.push(f.getName() + ' failed: ' + err.message);
    }
  }

  bustCache();
  const summary = (done.length ? 'Installed ' + done.join(', ') : 'Nothing fully installed.') +
    (stuck.length ? '  Needs another run: ' + stuck.join(' | ') : '');
  Logger.log(summary);
  return summary;
}

/**
 * Applies a plain-text update manifest: { "files": { "path/name.md": "..." } }.
 *
 * Everything in this hub is text, so a manifest avoids base64 entirely. That
 * matters because it is the only form an integration without file-replace can
 * push at all — a zip has to be encoded, and encoding a large file by hand is
 * both enormous and fragile. Small content updates go this way; anything the
 * size of atlas.html still travels as a zip somebody drops in.
 */
function applyManifest(hub, text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error('Update manifest is not valid JSON: ' + err.message);
  }

  const files = (payload && payload.files) || {};
  const written = [];
  const skipped = [];
  const failed = [];

  for (const rawPath in files) {
    const path = String(rawPath).replace(/\\/g, '/').replace(/^skill-atlas\//, '');
    const body = files[rawPath];

    if (!path || path.slice(-1) === '/') continue;
    if (path.indexOf('..') !== -1) { skipped.push(path + ' (suspicious path)'); continue; }
    if (isReserved(path)) continue;
    if (typeof body !== 'string') { skipped.push(path + ' (not text)'); continue; }
    if (body.length > MAX_FILE_CHARS) { skipped.push(path + ' (too large)'); continue; }

    const parts = path.split('/');
    const name = parts.pop();
    let dir = hub;
    for (let j = 0; j < parts.length; j++) dir = folderFor(dir, parts[j]);

    // Same reasoning as unpackInto: record the file that would not write, keep
    // going, and let the next run finish the job.
    try {
      writeTextResilient(dir, name, body, mimeFor(name));
      written.push(path);
    } catch (err) {
      failed.push(path + ' (' + (err && err.message ? err.message : err) + ')');
    }
  }

  return { written: written, skipped: skipped, failed: failed };
}

/** Run once. From then on, updates install themselves every five minutes. */
function createUpdateTrigger() {
  const existing = ScriptApp.getProjectTriggers();
  for (let i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'installUpdates') ScriptApp.deleteTrigger(existing[i]);
  }
  ScriptApp.newTrigger('installUpdates').timeBased().everyMinutes(5).create();
  return 'Automatic updates on: checking every 5 minutes.';
}

/** Turns automatic updates off again. */
function removeUpdateTrigger() {
  const existing = ScriptApp.getProjectTriggers();
  let n = 0;
  for (let i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'installUpdates') { ScriptApp.deleteTrigger(existing[i]); n++; }
  }
  return 'Automatic updates off. Removed ' + n + ' trigger(s).';
}

function mimeFor(name) {
  if (/\.html?$/i.test(name)) return 'text/html';
  if (/\.json$/i.test(name)) return 'application/json';
  if (/\.md$/i.test(name)) return 'text/markdown';
  if (/\.(mjs|js|gs)$/i.test(name)) return 'text/javascript';
  if (/\.svg$/i.test(name)) return 'image/svg+xml';
  return 'text/plain';
}

/**
 * Clears the wreckage of a failed install: files sitting in the hub root whose
 * name still contains a path separator, which means they were never unpacked
 * into folders. Safe to run any time; a correctly installed hub has none.
 */
function cleanupFlatFiles() {
  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  const it = hub.getFiles();
  const gone = [];
  while (it.hasNext()) {
    const f = it.next();
    const n = f.getName();
    if (n.indexOf('\\') !== -1 || n.indexOf('/') !== -1) { f.setTrashed(true); gone.push(n); }
  }
  Logger.log('Trashed ' + gone.length + ' mis-unpacked file(s).');
  return 'Trashed ' + gone.length + ' mis-unpacked file(s).';
}

/** Removes leftover files by exact name from the hub root. */
function tidyHubRoot(names) {
  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  const gone = [];
  (names || ['_probe.txt']).forEach(function (n) {
    const it = hub.getFilesByName(n);
    while (it.hasNext()) { it.next().setTrashed(true); gone.push(n); }
  });
  return gone.length ? 'Trashed ' + gone.length + ' file(s): ' + gone.join(', ') : 'Nothing to remove.';
}

/**
 * One skill's text, fetched when someone opens it rather than shipped with the
 * page. Keeps the atlas small no matter how many skills the hub holds.
 */
function getSkillSource(skillKey) {
  const parts = String(skillKey || '').split('/');
  if (parts.length !== 2 || !ID_RE.test(parts[0]) || !ID_RE.test(parts[1])) {
    return { ok: false, message: 'That is not a skill.' };
  }
  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  const skillsRoot = getFolder(hub, 'skills');
  const person = skillsRoot && getFolder(skillsRoot, parts[0]);
  const dir = person && getFolder(person, parts[1]);
  const raw = dir && readText(dir, 'SKILL.md');
  if (!raw) return { ok: false, message: 'That skill is no longer in the hub.' };
  return { ok: true, src: raw.replace(/\s+$/, '') };
}

/**
 * Who is asking.
 *
 * Only returns an email when the deployment runs as "User accessing the web
 * app". Under "Execute as: Me" this is blank for everyone but the deployer, and
 * the page falls back to asking people to type their name.
 *
 * A person's folder is found by email first, so someone whose folder was named
 * before identity existed keeps it. Renaming folders would break every
 * `installed` reference pointing at them.
 */
function whoAmI() {
  let email = '';
  try { email = (Session.getActiveUser().getEmail() || '').toLowerCase(); } catch (err) { email = ''; }
  if (!email) return { known: false };

  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  const skillsRoot = getFolder(hub, 'skills');

  // The index already knows which folder belongs to which address, and it is
  // cached. Only the matching profile is opened, for the arrangement, which has
  // to be current. This used to read every profile in the hub on every single
  // page load, so its cost grew with the number of people signed up.
  let person = '';
  try {
    const index = getIndex(hub);
    person = (index.EMAILS && index.EMAILS[email]) || '';
  } catch (err) { /* fall back to the scan below */ }

  if (person && skillsRoot) {
    const f = getFolder(skillsRoot, person);
    const txt = f && readText(f, 'profile.json');
    if (txt) {
      try {
        const prof = JSON.parse(txt);
        return {
          known: true, email: email, person: person,
          display_name: prof.display_name || '', team: prof.team || '',
          layout: (prof.layout && typeof prof.layout === 'object') ? prof.layout : {},
          version: currentVersion()
        };
      } catch (err) { /* a broken profile should not block sign-in */ }
    }
  }

  // Nobody has published under this address yet. They still get an identity, so
  // "Only mine" and publishing work on their first visit; the folder appears
  // the moment they publish something.
  //
  // A profile only matches by email, so a folder seeded by hand needs an
  // "email" line in its profile.json or its owner will not be recognised and
  // will end up with a second folder named after their address.
  return {
    known: true, email: email, person: personIdFromEmail(email),
    display_name: nameFromEmail(email), team: '',
    layout: {}, version: currentVersion()
  };
}

// "eileen.iglesias@example.com" -> "eileen.iglesias". The full local part, not
// the first name: first names collide and a folder id can never change once
// other people's profiles reference it.
function personIdFromEmail(email) {
  const local = String(email).split('@')[0].split('+')[0];
  const id = local.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return ID_RE.test(id) ? id : 'person' + String(Math.abs(hashCode(email)));
}

function nameFromEmail(email) {
  return String(email).split('@')[0].split('+')[0].split(/[._-]+/)
    .filter(function (w) { return !!w; })
    .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
    .join(' ');
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return h;
}

/**
 * Records that the caller has taken a skill, so the map reflects what people
 * actually use rather than only what they publish. Called when someone copies a
 * skill from the atlas.
 */
function recordSave(skillKey) {
  const me = whoAmI();
  if (!me.known) {
    return { ok: false, message: 'Not signed in, so this could not be recorded.' };
  }

  const parts = String(skillKey || '').split('/');
  if (parts.length !== 2 || !ID_RE.test(parts[0]) || !ID_RE.test(parts[1])) {
    return { ok: false, message: 'That is not a skill.' };
  }
  if (parts[0] === me.person) {
    return { ok: true, message: 'That one is already yours.', changed: false };
  }

  const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
  const mine = folderFor(folderFor(hub, 'skills'), me.person);

  let profile = {};
  const existing = readText(mine, 'profile.json');
  if (existing) { try { profile = JSON.parse(existing) || {}; } catch (err) { profile = {}; } }

  profile.email = me.email;
  profile.display_name = profile.display_name || me.display_name || me.person;
  profile.installed = profile.installed || [];
  profile.forked = profile.forked || [];
  profile.external = profile.external || [];

  const already = profile.installed.some(function (x) {
    return (typeof x === 'string' ? x : (x && x.skill)) === skillKey;
  });
  if (already) return { ok: true, message: 'Already in your skills.', changed: false };

  profile.installed.push({ skill: skillKey, installed_at: today() });
  profile.updated_at = today();
  writeText(mine, 'profile.json', JSON.stringify(profile, null, 2) + NL, 'application/json');

  // Patch the index instead of throwing it away. Falls back to the old
  // behaviour whenever the patch cannot be trusted to produce the same result
  // a rebuild would, so the cheap path is never the wrong path.
  if (patchInstall(hub, me, skillKey)) bustPage();
  else bustCache();

  return { ok: true, message: 'Added to your skills.', changed: true };
}

/**
 * Updates the cached index for one person taking one skill.
 *
 * Exactly two things change: that person's REFS.installed list, and the install
 * count on the skill they took. Every other person, every other skill and all
 * the parsed text is still correct, so rebuilding from Drive would mean reading
 * a few hundred files in order to change two numbers.
 *
 * Returns false rather than guessing whenever a rebuild would give a different
 * answer than this patch — no index on disk, an index that will not parse, or a
 * person who is not in it yet and whose card therefore has to be built. The
 * caller drops the index in those cases, which is what used to happen always.
 */
function patchInstall(hub, me, skillKey) {
  const raw = readText(hub, INDEX_FILE);
  if (!raw) return false;

  let index;
  try { index = JSON.parse(raw); } catch (err) { return false; }
  if (!index || !index.REFS || !index.SKILLS || !index.PEOPLE) return false;

  // A first-time visitor has no person card, no dept and no place on the
  // canvas. That is a shape the index does not have yet, not a number to
  // adjust, so it needs the real build.
  const known = index.PEOPLE.some(function (p) { return p && p.id === me.person; });
  if (!known) return false;

  const entry = index.REFS[me.person] || (index.REFS[me.person] = { installed: [], forked: [] });
  entry.installed = entry.installed || [];
  // Already there means the index and the profile disagree, because recordSave
  // only gets this far after checking the profile did not have it. Incrementing
  // on top of that would double-count, so hand it to a rebuild to settle.
  if (entry.installed.indexOf(skillKey) !== -1) return false;
  entry.installed.push(skillKey);

  // The page reads the count off the skill row, so it has to move with the ref
  // or the number under the box disagrees with the list beside it.
  const parts = skillKey.split('/');
  for (let i = 0; i < index.SKILLS.length; i++) {
    const s = index.SKILLS[i];
    if (s.author === parts[0] && s.id === parts[1]) { s.installs = (s.installs || 0) + 1; break; }
  }

  // recordSave has just written an email onto the profile, possibly for the
  // first time. Without this, whoAmI would not find them by address until
  // something else forced a rebuild.
  if (me.email) {
    index.EMAILS = index.EMAILS || {};
    index.EMAILS[String(me.email).toLowerCase()] = me.person;
  }

  try {
    writeTextResilient(hub, INDEX_FILE, JSON.stringify(index), 'application/json');
  } catch (err) {
    return false;   // let the caller drop it; a wrong index is worse than none
  }
  return true;
}

// Create the file, or update it in place if it already exists. Never leaves two
// files with the same name in a folder, which would make lookups ambiguous.
// Thrown by writeText when the target is a Google-native file. Kept as a
// constant so writeTextResilient can tell "wait and try again" apart from
// "waiting will not help".
const NOT_A_TEXT_FILE = 'is a Google file, not a text file, so it was left alone';

function writeText(folder, name, content, mime) {
  const it = folder.getFilesByName(name);
  if (it.hasNext()) {
    const f = it.next();

    // A Google Doc, Sheet, or Apps Script project has no text body to replace,
    // and setContent on one fails with "Access denied: DriveApp" — which reads
    // like a permissions problem and is not one. The live script project sits
    // in the hub root as a file called Code.gs, so a build carrying its own
    // Code.gs at the root used to collide with it and stop the whole install.
    const kind = f.getMimeType ? f.getMimeType() : '';
    if (kind && kind.indexOf('application/vnd.google-apps.') === 0) {
      throw new Error(name + ' ' + NOT_A_TEXT_FILE);
    }

    f.setContent(content);
    // A duplicate from an earlier manual upload would make reads unpredictable.
    while (it.hasNext()) it.next().setTrashed(true);
    return f;
  }
  return folder.createFile(name, content, mime || 'text/plain');
}

function folderFor(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/**
 * Throws away the built index as well as the page.
 *
 * Correct when the hub's CONTENT changed — a skill published, a skill deleted —
 * because the index holds parsed text from every file and there is no way to
 * know what a rewritten SKILL.md changed without reading it again.
 *
 * Not correct for a change that only touches one person's own bookkeeping. See
 * bustPage and patchInstall for that case.
 */
function bustCache() {
  // The index is the expensive thing to rebuild, so it goes with the cache.
  try {
    const hub = DriveApp.getFolderById(HUB_FOLDER_ID);
    const it = hub.getFilesByName(INDEX_FILE);
    while (it.hasNext()) it.next().setTrashed(true);
  } catch (err) { /* a stale index is recoverable with ?refresh=1 */ }

  bustPage();
}

/**
 * Clears the rendered page and bumps the version, leaving the index alone.
 *
 * For changes where the index is still correct or has already been patched in
 * place. Taking a colleague's skill alters one entry in REFS and one install
 * count and nothing else, so dropping the whole index for it made the next
 * visitor — anyone in the company — pay for a full Drive rebuild of all 34
 * skills. That is the "adding a skill takes forever" everyone feels, and it is
 * charged to the wrong person: the one who arrives next, not the one who acted.
 */
function bustPage() {
  bumpVersion();

  try {
    const cache = CacheService.getScriptCache();
    const countRaw = cache.get('atlas:n');
    const keys = ['atlas:n'];
    if (countRaw) {
      const n = parseInt(countRaw, 10);
      for (let i = 0; i < n; i++) keys.push('atlas:' + i);
    }
    cache.removeAll(keys);
  } catch (err) { /* a stale page for five minutes is not worth failing over */ }
}

// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------
function getFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}

// Lists a folder once and downloads only the wanted files that exist. Cheaper
// than one getFilesByName call per candidate name, because a miss still costs a
// full round trip.
function readFolderFiles(folder, wanted) {
  const out = {};
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const n = f.getName();
    if (wanted.indexOf(n) !== -1 && out[n] === undefined) {
      out[n] = f.getBlob().getDataAsString('UTF-8');
    }
  }
  return out;
}

function readText(folder, name) {
  const it = folder.getFilesByName(name);
  if (!it.hasNext()) return null;
  return it.next().getBlob().getDataAsString('UTF-8');
}

// ---------------------------------------------------------------------------
// cache — CacheService caps a single value at 100KB, and the atlas is larger
// than that once there are a few skills, so it is split across keys.
// ---------------------------------------------------------------------------
const CHUNK = 90000;

function cacheGet(key) {
  const cache = CacheService.getScriptCache();
  const countRaw = cache.get(key + ':n');
  if (!countRaw) return null;

  const n = parseInt(countRaw, 10);
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);

  const parts = cache.getAll(keys);
  let out = '';
  for (let i = 0; i < n; i++) {
    const part = parts[key + ':' + i];
    if (part == null) return null;    // a chunk expired early — rebuild
    out += part;
  }
  return out;
}

function cachePut(key, value, ttl) {
  const cache = CacheService.getScriptCache();
  const chunks = {};
  let n = 0;
  for (let i = 0; i < value.length; i += CHUNK) {
    chunks[key + ':' + n] = value.substr(i, CHUNK);
    n++;
  }
  chunks[key + ':n'] = String(n);
  try { cache.putAll(chunks, ttl); } catch (err) { /* oversized: serve uncached */ }
}

function errorPage(err) {
  return '<!doctype html><meta charset="utf-8">' +
    '<div style="font:15px/1.6 system-ui,sans-serif;max-width:46ch;margin:64px auto;padding:0 24px">' +
    '<h1 style="font-size:18px">The atlas could not be built</h1>' +
    '<p style="color:#555">' + escHtml(err && err.message ? err.message : String(err)) + '</p>' +
    '<p style="color:#555">The skills themselves are unaffected — they are files in the ' +
    'Shared Drive and can always be opened directly. See HANDOFF.md in the hub folder.</p></div>';
}
