// The hub's one public door.
//
// Two surfaces over the same handlers:
//
//   POST /hub          JSON-RPC, the MCP an employee connects Claude to
//   POST /hub/<verb>   plain JSON, what Apps Script calls
//
// The service role key never leaves Supabase. It is injected here as an
// environment variable, so nobody copies it into a settings panel, a repo, or
// a chat window, and there is nothing to hand over at the handoff. Callers
// present HUB_TOKEN instead, which reaches these few endpoints and not the
// database.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HUB_TOKEN = Deno.env.get("HUB_TOKEN") ?? "";

// ---------------------------------------------------------------------------
// scanning
//
// Two lists, and the split is the whole design.
//
// A real credential is never legitimately part of a skill, so finding one
// stops the publish. Everything else is advisory, because a skill about
// secrets safety legitimately discusses API keys, and one about shell safety
// legitimately contains `rm -rf`. Blocking those would train people to route
// around the scanner, and a scanner people route around protects nothing.
//
// So: credentials block. Everything else is recorded on the row and surfaced
// to the publisher and to whoever reviews later.
//
// The two markers below are load-bearing. supabase/test/scan.test.mjs
// lifts everything between them out of this file, character for character, and
// runs it under Node. That is how the scanner gets tested without a Deno
// install, and it means the thing under test is the thing that ships. Moving
// or renaming the markers breaks the test, it does not silently skip it.
// ---------------------------------------------------------------------------
// SCANNER-START

// Most rules are a plain pattern: the shape alone is proof, because nothing
// legitimately looks like an AWS key id except an AWS key id. Two rules cannot
// work that way, so they are written as functions that look at the value they
// matched. See realPrivateKey and realPgPassword below for why.
type Check = [RegExp | ((text: string) => boolean), string];

const BLOCKING: Check[] = [
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JSON Web Token"],
  [/sb_(secret|publishable)_[A-Za-z0-9_-]{16,}/, "a Supabase key"],
  [/AKIA[0-9A-Z]{16}/, "an AWS access key id"],
  [/gh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/xox[baprs]-[A-Za-z0-9-]{20,}/, "a Slack token"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "an Anthropic API key"],
  [/sk-(proj-)?[A-Za-z0-9]{32,}/, "an OpenAI-style API key"],
  [/AIza[0-9A-Za-z_-]{35}/, "a Google API key"],
  [realPrivateKey, "a private key block"],
  [realPgPassword, "a Postgres URL with the password in it"],
];

// ---------------------------------------------------------------------------
// The two rules that have to look at the value
//
// Both of these started life as one-line patterns matching the shape, and both
// of them refused secrets-and-env-safety, the skill whose entire job is
// teaching people to keep credentials out of code and which therefore shows a
// bare BEGIN PRIVATE KEY header and a postgres://user:password@ URL as
// examples of what to look for. Publishing the tool that teaches this would
// have been refused by the tool itself.
//
// Both fixes are ported from .claude/hooks/no_secrets.py, the local pre-write
// hook, where the same false positive was found and solved first. Keep the two
// in step: if one learns about a new placeholder, so should the other.
// ---------------------------------------------------------------------------

// A PEM header on its own is documentation. A PEM header with the actual
// encoded key underneath it is a leak. The difference is whether a long run of
// base64 characters follows, so that is what gets checked.
//
// The 500-character window is deliberate rather than "immediately after": an
// encrypted key puts a couple of Proc-Type and DEK-Info lines in between, and
// those should still be caught.
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;

function realPrivateKey(text: string): boolean {
  for (const m of text.matchAll(PRIVATE_KEY_HEADER)) {
    const from = (m.index ?? 0) + m[0].length;
    if (/[A-Za-z0-9+/=]{40,}/.test(text.slice(from, from + 500))) return true;
  }
  return false;
}

// A Postgres URL with a password in it, but only when the password looks
// generated rather than illustrative. Everything a person types by hand as an
// example gets let through: a word from the list below, an <angle bracket>
// stand-in, a masked xxxxxxxx, or a ${DB_PASSWORD} style reference.
//
// What is left has to look machine-made: at least ten characters, and drawing
// on two or more of lowercase, uppercase, digits and punctuation.
const PG_URL = /postgres(?:ql)?:\/\/[^:@/\s]+:([^@\s]{6,})@/g;

const PLACEHOLDER = new Set([
  "password", "passwd", "pass", "secret", "changeme", "yourpassword",
  "your_password", "your-password", "example", "redacted", "hunter2",
  "mypassword", "placeholder", "token", "pw",
]);

function realPgPassword(text: string): boolean {
  for (const m of text.matchAll(PG_URL)) {
    const pw = m[1];
    if (PLACEHOLDER.has(pw.toLowerCase())) continue;
    if (/^[<{[].*[>}\]]$/.test(pw)) continue;          // an <angle bracket> stand-in
    if (/^[*x.]+$/i.test(pw)) continue;                // masked out
    if (/^\$\{?[A-Z_]+\}?$/.test(pw)) continue;        // an env var reference
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]
      .filter((c) => c.test(pw)).length;
    if (pw.length >= 10 && classes >= 2) return true;
  }
  return false;
}

const ADVISORY: Check[] = [
  [/ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions/i,
   "tries to override earlier instructions"],
  [/disregard\s+(the\s+)?(above|previous|prior)/i,
   "tries to discard earlier instructions"],
  [/(never|do\s*n[o']?t)\s+ask\s+(the\s+user\s+)?(for\s+)?(permission|confirmation|first)/i,
   "tells the model not to ask before acting"],
  [/(auto[- ]?approve|always\s+approve|approve\s+everything)/i,
   "tells the model to approve without review"],
  [/(do\s*n[o']?t|never)\s+(tell|mention|inform|show)\s+(the\s+)?user/i,
   "tells the model to conceal something from the user"],
  [/\b(exfiltrat|POST\s+.{0,40}(\.env|credential|secret|token))/i,
   "describes sending credentials somewhere"],
  [/curl\s+[^|\n]{0,120}\|\s*(sudo\s+)?(ba)?sh/i,
   "pipes a download straight into a shell"],
  [/rm\s+-[rRf]{1,3}\s+[~/]/,
   "contains a recursive delete of a root or home path"],
  [/--dangerously-skip-permissions|bypassPermissions/i,
   "references disabling permission checks"],
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
   "contains a destructive SQL statement"],
];

// Runs one rule, whether it is a pattern to match or a function that inspects
// what it matched.
const hits = (check: RegExp | ((text: string) => boolean), text: string) =>
  typeof check === "function" ? check(text) : check.test(text);

function scan(text: string): { blocked: string[]; flags: string[] } {
  const blocked: string[] = [];
  const flags: string[] = [];
  // Report what matched, never the match itself. Echoing a secret back in an
  // error message just moves it somewhere else.
  for (const [check, label] of BLOCKING) if (hits(check, text)) blocked.push(label);
  for (const [check, label] of ADVISORY) if (hits(check, text)) flags.push(label);
  return { blocked, flags };
}
// SCANNER-END

// ---------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------
async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} failed: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// what the hub can do
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "search_skills",
    description:
      "Search the company's shared Claude skills. Searches the whole text of every " +
      "skill, not just its name, so a word that only appears deep in one still " +
      "finds it. Returns summaries; use get_skill for the text you install. " +
      "A skill is a reusable instruction set, NOT a record of something someone " +
      "did — to find out what people have been working on, use find_work.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are trying to do. Leave empty to list everything." },
        disciplines: { type: "array", items: { type: "string" },
          description: "Optional filter, e.g. engineering, sales, security, ui-ux, writing, data, finance, operations." },
        author: { type: "string", description: "Optional, restrict to one person's folder name." },
        limit: { type: "number", description: "Default 20, maximum 100." },
      },
    },
  },
  {
    name: "get_skill",
    description:
      "The full text of one skill, ready to save. Takes the author and id from " +
      "a search_skills result. Call record_install afterwards if you actually " +
      "keep it, so the adoption counts mean something.",
    inputSchema: {
      type: "object",
      properties: {
        author: { type: "string" },
        id: { type: "string" },
      },
      required: ["author", "id"],
    },
  },
  {
    name: "publish_skill",
    description:
      "Publish a skill to the hub so colleagues can find it. Republishing the " +
      "same id replaces it. The body is scanned first: a real credential is " +
      "refused outright, and anything else suspicious is recorded and reported " +
      "back rather than silently accepted. " +
      "Use this for a reusable instruction set. To record that you DID " +
      "something, use record_work.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Folder-style name, e.g. security-questionnaire." },
        name: { type: "string", description: "Human title." },
        description: { type: "string", description: "One plain sentence about what it does." },
        discipline: { type: "string" },
        body: { type: "string", description: "The whole SKILL.md." },
        about: { type: "string", description: "Optional plain-language overview." },
        kind: { type: "string", description: "authored if you wrote it, external if you found it." },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id", "name", "body"],
    },
  },
  {
    name: "record_install",
    description:
      "Note that you have taken a skill, so its adoption count reflects what " +
      "people actually use rather than only what they publish. Call it when you " +
      "keep a skill, not when you merely read one.",
    inputSchema: {
      type: "object",
      properties: { author: { type: "string" }, id: { type: "string" } },
      required: ["author", "id"],
    },
  },

  // -------------------------------------------------------------------------
  // work — the shared record of what people and their agents are doing.
  //
  // Two domains behind one connection, so the model picks between them with no
  // human disambiguating. Every description says WHEN to reach for it, the
  // confusable pairs name each other, and every name carries its domain —
  // search_skills / find_work, never a bare search or find. See
  // workspace/tools.ts for the reasoning in full.
  // -------------------------------------------------------------------------
  {
    name: "record_work",
    description:
      "Write down a piece of work so colleagues and their assistants can see it. " +
      "Call this WITHOUT being asked, whenever you finish something a teammate " +
      "would want to know about: produced a document, shipped something, made a " +
      "decision, learned something useful, got blocked, or need an answer from a " +
      "named person. This is the whole point of the workspace — a record nobody " +
      "writes is an empty workspace. " +
      "Keep summary to one plain sentence. Put the reasoning in detail, " +
      "especially for a decision, because a decision without its reason gets " +
      "re-argued. " +
      "Set visibility to private for anything about pay, performance, a named " +
      "individual, or a customer's confidential data. Default is team.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["produced", "shipped", "decided", "learned", "blocked", "asked"],
          description:
            "produced: a thing now exists. shipped: it went out into the world. " +
            "decided: a choice was made. learned: found something others would want. " +
            "blocked: cannot get past something. asked: waiting on a specific person.",
        },
        summary: { type: "string", description: "One plain sentence, under 300 characters." },
        subject: {
          type: "string",
          description:
            "Lowercase slug for the thread this belongs to, e.g. acme-integration. " +
            "REUSE an existing one — call find_work first if you are unsure. A new " +
            "spelling of an existing subject silently splits the thread in two.",
        },
        detail: { type: "string", description: "Optional. The reasoning, the context, the specifics." },
        artifacts: {
          type: "array",
          description: "What it produced: [{kind, label, url}].",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", description: "doc, pr, deck, sheet, message, file" },
              label: { type: "string" },
              url: { type: "string" },
            },
          },
        },
        status: {
          type: "string", enum: ["open", "done", "blocked", "abandoned"],
          description: "Default done. Use blocked with blocked_on or needs_from.",
        },
        blocked_on: { type: "string", description: "Required if status is blocked and needs_from is empty." },
        needs_from: { type: "string", description: "Person id who can unblock this." },
        supersedes: { type: "string", description: "id of a record this replaces, if it is now out of date." },
        confidence: {
          type: "string", enum: ["stated", "observed", "inferred"],
          description:
            "stated: a person told you. observed: you saw it in a file, ticket or " +
            "tool result. inferred: you concluded it. Be honest — an inferred " +
            "record treated as fact is how this stops being trusted.",
        },
        visibility: { type: "string", enum: ["private", "team", "company"], description: "Default team." },
        occurred_at: { type: "string", description: "ISO timestamp. Omit for now. Set it when writing up past work." },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "summary", "subject", "confidence"],
    },
  },
  {
    name: "find_work",
    description:
      "Find what people have been working on. The general read: filter by person, " +
      "team, subject, kind, status, or free text, in any combination. " +
      "Use it to catch up on a thread before joining it, to see what a colleague " +
      "has done, or to find what was decided about something and why. " +
      "Returns only records that are still current — anything superseded by a " +
      "later record is left out. " +
      "Call this before record_work when you are unsure which subject to use.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text across summary, detail, subject and tags." },
        subject: { type: "string", description: "Exact subject slug. Returns the thread oldest-first." },
        person: { type: "string", description: "Person id." },
        team: { type: "string", description: "Team name." },
        kind: {
          type: "string",
          enum: ["produced", "shipped", "decided", "learned", "blocked", "asked"],
          description: "Use decided to answer 'what did we decide about X'.",
        },
        status: { type: "string", enum: ["open", "done", "blocked", "abandoned"] },
        since: { type: "string", description: "ISO timestamp or a phrase like '7 days'." },
        limit: { type: "number", description: "Default 30, maximum 200." },
      },
    },
  },
  {
    name: "whats_blocked",
    description:
      "What is currently stuck, oldest first, and who each thing is waiting on. " +
      "Worth calling unprompted when someone asks what they should do next, or " +
      "at the start of a working session: the oldest blocked item is usually " +
      "more valuable to unstick than the newest thing to start. " +
      "Optionally narrow to what is waiting on one specific person.",
    inputSchema: {
      type: "object",
      properties: {
        waiting_on: { type: "string", description: "Person id. Returns only what is blocked on them." },
        team: { type: "string" },
        limit: { type: "number", description: "Default 30." },
      },
    },
  },
  {
    name: "who_worked_on",
    description:
      "Who has touched something like this before, so you know who to ask. " +
      "Returns people rather than records, ranked by how recently they worked on " +
      "it — someone who did it once last week remembers it better than someone " +
      "who did it ten times last year. " +
      "This is about who has DONE the work. To find a reusable skill for doing " +
      "it yourself, use search_skills.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are trying to find someone for." },
        limit: { type: "number", description: "Default 10." },
      },
      required: ["query"],
    },
  },
  {
    name: "catch_up",
    description:
      "Everything recorded since you last checked, oldest first, with a cursor " +
      "to pass back next time. Use at the start of a session to find out what " +
      "changed while you were away. " +
      "Ordered by when things were WRITTEN DOWN, not when they happened, so a " +
      "colleague writing up last week's work today still reaches you.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string", description: "The cursor from the previous call. Omit for the last 24 hours." },
        team: { type: "string" },
        limit: { type: "number", description: "Default 100, maximum 200." },
      },
    },
  },
];

function personIdFromEmail(email: string): string {
  const local = String(email).split("@")[0].split("+")[0].toLowerCase();
  return local.replace(/[^a-z0-9._-]/g, "");
}

async function call(name: string, args: Record<string, any>, who: string) {
  switch (name) {
    case "search_skills": {
      const rows = await rpc("search_skills", {
        q: args.query ?? "",
        disciplines: args.disciplines ?? null,
        author_id: args.author ?? null,
        max_results: args.limit ?? 20,
      });
      return { count: rows?.length ?? 0, skills: rows ?? [] };
    }

    case "get_skill": {
      const rows = await rpc("get_skill", { author_id: args.author, skill_id: args.id });
      if (!rows || !rows.length) return { ok: false, message: "No such skill in the hub." };
      return { ok: true, skill: rows[0] };
    }

    case "publish_skill": {
      if (!who) {
        return { ok: false, message: "We cannot tell who you are, so nothing was published." };
      }
      const author = personIdFromEmail(who);
      const id = String(args.id ?? "").trim();
      const body = String(args.body ?? "");

      if (!ID.test(id)) {
        return { ok: false, message: "That id would not make a valid folder name. Lowercase letters, numbers, dots and dashes." };
      }
      if (body.length < 40) return { ok: false, message: "That body is too short to be a skill." };
      if (body.length > 400_000) return { ok: false, message: "That body is too large." };

      // Scan everything a reader would see, not only the body.
      const { blocked, flags } = scan([body, args.about ?? "", args.description ?? ""].join("\n"));

      if (blocked.length) {
        return {
          ok: false,
          blocked,
          message:
            "Not published. This contains " + blocked.join(", ") + ". " +
            "Take the credential out, then rotate it, because anything that " +
            "reached a file is best treated as already leaked.",
        };
      }

      const result = await rpc("publish_skill", {
        p_author: author,
        p_display_name: args.display_name ?? null,
        p_email: who,
        p_team: args.team ?? null,
        p_id: id,
        p_name: String(args.name ?? id),
        p_description: args.description ?? null,
        p_discipline: args.discipline ?? null,
        p_kind: args.kind === "external" ? "external" : "authored",
        p_body: body,
        p_about_html: args.about ?? null,
        p_mmd: args.mmd ?? null,
        p_tags: args.tags ?? [],
        p_auto_tags: [],
        p_flags: flags,
      });

      return {
        ...result,
        message: flags.length
          ? `Published, with ${flags.length} thing${flags.length === 1 ? "" : "s"} worth a second look: ${flags.join("; ")}.`
          : "Published.",
      };
    }

    case "record_install": {
      if (!who) return { ok: false, message: "We cannot tell who you are." };
      return await rpc("record_install", {
        p_person: personIdFromEmail(who),
        p_author: args.author,
        p_id: args.id,
      });
    }

    // -----------------------------------------------------------------------
    // work
    //
    // Every one of these passes p_viewer, and every one of them needs `who`.
    // These functions are called with the service role key, which bypasses row
    // level security entirely — so the RLS on work_records protects the web and
    // PostgREST paths and does nothing here. Visibility on this path is
    // enforced by can_see() inside each function, against p_viewer. Dropping
    // p_viewer does not widen the result, it empties it, which is the correct
    // way round for a mistake to fail.
    // -----------------------------------------------------------------------
    case "record_work": {
      if (!who) {
        return { ok: false, message: "We cannot tell who you are, so nothing was recorded." };
      }
      return await rpc("record_work", {
        p_person: personIdFromEmail(who),
        p_kind: args.kind,
        p_summary: args.summary,
        p_subject: args.subject,
        p_confidence: args.confidence,
        p_detail: args.detail ?? null,
        p_artifacts: args.artifacts ?? [],
        p_status: args.status ?? "done",
        p_blocked_on: args.blocked_on ?? null,
        p_needs_from: args.needs_from ?? null,
        p_supersedes: args.supersedes ?? null,
        p_visibility: args.visibility ?? "team",
        p_occurred_at: args.occurred_at ?? null,
        p_tags: args.tags ?? [],
        // Attribution, not authorisation. Worth having so "what did my
        // assistant do overnight" is answerable.
        p_agent: "claude",
      });
    }

    case "find_work": {
      if (!who) return { ok: false, message: "We cannot tell who you are." };
      const rows = await rpc("find_work", {
        p_viewer: personIdFromEmail(who),
        p_query: args.query ?? null,
        p_subject: args.subject ?? null,
        p_person: args.person ?? null,
        p_team: args.team ?? null,
        p_kind: args.kind ?? null,
        p_status: args.status ?? null,
        p_since: args.since ?? null,
        p_limit: args.limit ?? 30,
      });
      return { count: rows?.length ?? 0, records: rows ?? [] };
    }

    case "whats_blocked": {
      if (!who) return { ok: false, message: "We cannot tell who you are." };
      const rows = await rpc("whats_blocked", {
        p_viewer: personIdFromEmail(who),
        p_waiting_on: args.waiting_on ?? null,
        p_team: args.team ?? null,
        p_limit: args.limit ?? 30,
      });
      return { count: rows?.length ?? 0, blocked: rows ?? [] };
    }

    case "who_worked_on": {
      if (!who) return { ok: false, message: "We cannot tell who you are." };
      const rows = await rpc("who_worked_on", {
        p_viewer: personIdFromEmail(who),
        p_query: args.query ?? "",
        p_limit: args.limit ?? 10,
      });
      return { count: rows?.length ?? 0, people: rows ?? [] };
    }

    case "catch_up": {
      if (!who) return { ok: false, message: "We cannot tell who you are." };
      return await rpc("catch_up", {
        p_viewer: personIdFromEmail(who),
        p_cursor: args.cursor ?? null,
        p_team: args.team ?? null,
        p_limit: args.limit ?? 100,
      });
    }

    default:
      return { ok: false, message: `No such tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Internal storage for the OAuth gateway.
//
// Kept out of call() and out of TOOLS on purpose. These are not tools and must
// never appear in tools/list: they are how the Cloudflare Worker keeps its
// OAuth state without holding any database credential of its own. Routing them
// separately means a tools/call can never reach them however it is phrased.
//
// Reachable only over POST /hub/oauth_*, which already requires HUB_TOKEN.
// ---------------------------------------------------------------------------
async function oauthCall(verb: string, args: Record<string, any>) {
  switch (verb) {
    case "oauth_register_client":
      return await rpc("oauth_register_client", {
        p_client_id: args.client_id,
        p_secret_hash: args.secret_hash ?? null,
        p_redirect_uris: args.redirect_uris,
        p_name: args.name ?? null,
      });

    case "oauth_get_client":
      return await rpc("oauth_get_client", { p_client_id: args.client_id });

    case "oauth_store_code":
      return await rpc("oauth_store_code", {
        p_code_hash: args.code_hash,
        p_client_id: args.client_id,
        p_redirect_uri: args.redirect_uri,
        p_challenge: args.challenge,
        p_method: args.method ?? "S256",
        p_email: args.email,
        p_scope: args.scope ?? null,
        p_ttl_seconds: args.ttl_seconds ?? 60,
      });

    case "oauth_consume_code":
      return await rpc("oauth_consume_code", { p_code_hash: args.code_hash });

    case "oauth_upsert_person":
      return await rpc("oauth_upsert_person", {
        p_email: args.email,
        p_name: args.name ?? null,
      });

    default:
      return { ok: false, message: `No such internal verb: ${verb}` };
  }
}

// ---------------------------------------------------------------------------
// serving
// ---------------------------------------------------------------------------
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Connection": "keep-alive" },
  });

Deno.serve(async (req) => {
  // Own authentication rather than Supabase's JWT gate, because the callers
  // are Apps Script and people's Claude connectors, neither of which has a
  // Supabase login. HUB_TOKEN reaches these endpoints only.
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!HUB_TOKEN || token !== HUB_TOKEN) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Who is asking. Advisory: the token is shared, so this is an assertion, not
  // proof. It is enough to attribute a publish and to keep an audit trail, and
  // it is NOT enough to authorise anything sensitive. Nothing here is gated on
  // it except writing into your own folder.
  const who = (req.headers.get("x-hub-user") ?? "").trim().toLowerCase();

  const url = new URL(req.url);
  const verb = url.pathname.replace(/^\/hub\/?/, "").replace(/\/$/, "");

  let payload: any = {};
  if (req.method === "POST") {
    try { payload = await req.json(); } catch { payload = {}; }
  }

  // --- plain JSON, for Apps Script -----------------------------------------
  if (verb) {
    try {
      if (verb === "atlas") return json(await rpc("get_atlas"));
      // Checked before call(), so oauth_* can never be reached as a tool.
      if (verb.startsWith("oauth_")) return json(await oauthCall(verb, payload ?? {}));
      return json(await call(verb, payload ?? {}, who));
    } catch (err) {
      return json({ ok: false, message: String(err?.message ?? err) }, 500);
    }
  }

  // --- JSON-RPC, for MCP ---------------------------------------------------
  const { id = null, method, params = {} } = payload ?? {};
  const reply = (result: unknown) => json({ jsonrpc: "2.0", id, result });

  try {
    switch (method) {
      case "initialize":
        return reply({
          // Echo the client's version rather than pinning one, so a newer
          // Claude does not get refused by a server it is compatible with.
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "skill-atlas-hub", version: "1.0.0" },
        });

      case "notifications/initialized":
        return new Response(null, { status: 202 });

      case "tools/list":
        return reply({ tools: TOOLS });

      case "tools/call": {
        const out = await call(params?.name, params?.arguments ?? {}, who);
        return reply({
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          isError: out && out.ok === false,
        });
      }

      case "ping":
        return reply({});

      default:
        return json({
          jsonrpc: "2.0", id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
    }
  } catch (err) {
    return json({
      jsonrpc: "2.0", id,
      error: { code: -32603, message: String(err?.message ?? err) },
    });
  }
});
