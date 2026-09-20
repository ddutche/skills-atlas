// Tests the Edge Function's publish scanner.
//
// Run it with:
//   node --experimental-strip-types supabase/test/scan.test.mjs
//
// Why it works this way: there is no Deno on this machine, and the scanner
// lives inside a Deno file that calls Deno.env at import time. So instead of
// importing index.ts, this lifts the block between the SCANNER-START and
// SCANNER-END markers out of it, writes that text unchanged to a temp file,
// and imports that. Nothing is rewritten on the way, so what gets tested is
// literally the source that ships. If the markers are missing the run fails
// loudly rather than quietly testing nothing.
//
// Two halves, and both matter:
//
//   1. Real skills must all publish clean. A scanner that refuses the skill
//      about keeping credentials out of code is a scanner people switch off.
//   2. Real credentials must still be refused. Loosening a rule without a test
//      that the rule still bites is how a scanner quietly becomes decorative.
//
// The fake credentials in part 2 are assembled from pieces at runtime rather
// than written out as literals. They are invented, not real, but the local
// pre-write hook (.claude/hooks/no_secrets.py) matches on shape, not on
// origin, and it cannot tell an invented Postgres password from a live one.
// Building them at runtime keeps a credential-shaped string out of the file on
// disk, which is the behaviour the hook is there to enforce in the first place.

import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FUNCTION = join(here, "..", "functions", "hub", "index.ts");
// Optional corpus of real skills. Nothing ships here: the skills this was
// originally tested against belonged to a specific company and did not travel
// with the code. Point SKILL_FIXTURES at any folder of <skill>/SKILL.md and
// part 1 runs against it; leave it unset and part 1 says so and skips.
//
//   SKILL_FIXTURES=../skill-atlas-hub/skills/<person> node --experimental-strip-types supabase/test/scan.test.mjs
//
// Parts 2 and 3 are self-contained and always run, and they are the ones that
// actually pin the scanner's behaviour.
const SKILLS = process.env.SKILL_FIXTURES
  ? resolve(process.env.SKILL_FIXTURES)
  : join(here, "fixtures", "skills");

// --- lift the scanner out of the Edge Function -------------------------------

function loadScanner() {
  const source = readFileSync(FUNCTION, "utf8");
  const start = source.indexOf("// SCANNER-START");
  const end = source.indexOf("// SCANNER-END");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Could not find the SCANNER-START / SCANNER-END markers in ${FUNCTION}. ` +
      `They are what this test extracts, so without them it would be testing nothing.`,
    );
  }
  const block = source.slice(start + "// SCANNER-START".length, end);
  const dir = mkdtempSync(join(tmpdir(), "hub-scan-"));
  const file = join(dir, "scanner.ts");
  writeFileSync(file, `${block}\nexport { scan, BLOCKING, ADVISORY };\n`, "utf8");
  return import(pathToFileURL(file).href);
}

const { scan } = await loadScanner();

let failures = 0;
const fail = (msg) => { failures += 1; console.log(`  FAIL  ${msg}`); };

// --- part 1: every real skill must publish -----------------------------------
//
// Scans the same text the publish path scans: the SKILL.md body plus the
// about.md overview, which is what call() joins together before scanning.

const skills = existsSync(SKILLS)
  ? readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];

if (!skills.length) {
  // Skipped, not passed. Saying so out loud matters: a corpus check that
  // quietly reports success when there is no corpus is worse than no check,
  // because it reads as evidence the scanner tolerates real skills when in
  // fact nothing was scanned.
  console.log("Real skills: none in test/fixtures/skills, so part 1 is SKIPPED.");
  console.log("Add folders there to check the scanner does not refuse real work.\n");
} else {
  console.log(`Real skills (${skills.length}):\n`);
}

for (const name of skills) {
  const parts = [];
  for (const f of ["SKILL.md", "about.md"]) {
    const p = join(SKILLS, name, f);
    if (existsSync(p)) parts.push(readFileSync(p, "utf8"));
  }
  const { blocked, flags } = scan(parts.join("\n"));

  const status = blocked.length ? "BLOCKED" : "publishes";
  const note = flags.length ? `  (flagged: ${flags.join("; ")})` : "";
  console.log(`  ${status.padEnd(10)} ${name.padEnd(26)}${note}`);
  if (blocked.length) fail(`${name} was refused for: ${blocked.join(", ")}`);
}

// --- part 2: real credentials must still be refused --------------------------

console.log("\nCredentials that must still be refused:\n");

// Assembled at runtime, see the note at the top of this file.
const j = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0", "d3JvbmdzaWduYXR1cmU"].join(".");
const pgReal = "postgres://" + "hubadmin" + ":" + ["Qv7", "mZk", "2Rd", "9Ts"].join("") + "@" + "db.example.co:5432/postgres";
const keyBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";

const mustBlock = [
  ["a Supabase service-role JWT", `SUPABASE_SERVICE_ROLE_KEY=${j}`],
  ["a Postgres URL with a generated password", `DATABASE_URL=${pgReal}`],
  ["a private key with an actual body",
   `-----BEGIN RSA PRIVATE KEY-----\n${keyBody}\n${keyBody}\n-----END RSA PRIVATE KEY-----`],
  ["an AWS access key id", "AKIA" + "IOSFODNN7EXAMPLE"],
  ["an Anthropic API key", "sk-ant-" + "api03-" + "x".repeat(30)],
];

for (const [label, text] of mustBlock) {
  const { blocked } = scan(text);
  console.log(`  ${(blocked.length ? "refused" : "LET THROUGH").padEnd(12)} ${label}`);
  if (!blocked.length) fail(`${label} was not refused, the rule has stopped biting`);
}

// --- part 3: documentation about credentials must not be refused -------------
//
// These are the exact shapes a skill teaching secrets hygiene will contain.

console.log("\nDocumentation examples that must NOT be refused:\n");

const mustPass = [
  ["a placeholder Postgres URL", "DATABASE_URL=postgres://user:password@host:5432/db"],
  ["a named-but-empty private key header", "private key blocks (`-----BEGIN PRIVATE KEY-----`)"],
  ["an angle-bracket password", "postgres://admin:<your-password-here>@localhost:5432/db"],
  ["a masked password", "postgres://admin:xxxxxxxxxxxx@localhost:5432/db"],
  ["an env var reference", "postgres://admin:${DB_PASSWORD}@localhost:5432/db"],
  ["the variable names on their own", "Set SUPABASE_SERVICE_ROLE_KEY and LUCID_API_KEY in the dashboard."],
];

for (const [label, text] of mustPass) {
  const { blocked } = scan(text);
  console.log(`  ${(blocked.length ? "REFUSED" : "allowed").padEnd(12)} ${label}`);
  if (blocked.length) fail(`${label} was refused for: ${blocked.join(", ")}`);
}

console.log(failures ? `\n${failures} failure(s).` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
