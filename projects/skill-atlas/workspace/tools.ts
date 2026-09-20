// The unified tool surface — draft 1, 11 August 2026.
//
// One MCP connection, two domains. Merge this TOOLS array into
// supabase/functions/hub/index.ts, replacing the skills-only one, and add the
// matching cases to call().
//
// NOT WIRED UP YET. The five work_* tools each need a SQL function behind them
// the way search_skills and get_skill already do — the rpc() helper posts to
// /rest/v1/rpc/<name>, so a tool with no function is a 404 at runtime, not a
// compile error. queries.sql has the bodies; they need wrapping.
//
// ---------------------------------------------------------------------------
// Why the descriptions are written the way they are
//
// With nine tools from two domains behind one connection, the model picks
// without a human disambiguating, and it picks by reading these strings. Three
// rules came out of that:
//
//   1. Every description says WHEN to reach for it, not just what it does.
//   2. The pairs that could be confused name each other explicitly. "A skill is
//      an instruction set, not a record of work — for that use find_work" costs
//      twelve words and removes the only genuinely ambiguous choice here.
//   3. The name carries the domain. search_skills / find_work, never search /
//      find. A bare verb in a multi-domain server is an invitation to guess.
//
// The reads are split four ways rather than collapsed into one filtered
// endpoint because they have different RETURN shapes, not because they have
// different filters. find_work returns records; who_worked_on returns people;
// catch_up returns records plus a cursor. One tool returning three shapes is
// harder to use than three tools returning one each.
// ---------------------------------------------------------------------------

export const TOOLS = [
  // -------------------------------------------------------------------------
  // skills — the catalogue. Reusable instructions people wrote.
  // -------------------------------------------------------------------------
  {
    name: "search_skills",
    description:
      "Search the shared catalogue of Claude skills colleagues have written and " +
      "published. Searches the whole text of every skill, not just its name, so a " +
      "word that only appears deep inside one still finds it. Returns summaries; " +
      "use get_skill for the text you actually install. " +
      "A skill is a reusable instruction set, NOT a record of something someone " +
      "did — to find out what people have been working on, use find_work.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are trying to do. Leave empty to list everything." },
        disciplines: {
          type: "array", items: { type: "string" },
          description: "Optional filter, e.g. engineering, sales, security, ui-ux, writing, data, finance, operations.",
        },
        author: { type: "string", description: "Optional, restrict to one person's folder name." },
        limit: { type: "number", description: "Default 20, maximum 100." },
      },
    },
  },
  {
    name: "get_skill",
    description:
      "The full text of one skill, ready to save. Takes the author and id from a " +
      "search_skills result. Call record_install afterwards if you actually keep it, " +
      "so the adoption counts mean something.",
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
      "Publish a skill to the catalogue so colleagues can find it. Republishing the " +
      "same id replaces it. The body is scanned first: a real credential is refused " +
      "outright, and anything else suspicious is recorded and reported back rather " +
      "than silently accepted. " +
      "Use this for a reusable instruction set. To record that you DID something, " +
      "use record_work.",
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
      "Note that you have taken a skill, so its adoption count reflects what people " +
      "actually use rather than only what they publish. Call it when you keep a skill, " +
      "not when you merely read one.",
    inputSchema: {
      type: "object",
      properties: { author: { type: "string" }, id: { type: "string" } },
      required: ["author", "id"],
    },
  },

  // -------------------------------------------------------------------------
  // work — the shared record of what people and their agents are doing.
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
      "Keep summary to one plain sentence. Put the reasoning in detail, especially " +
      "for a decision, because a decision without its reason gets re-argued. " +
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
            "stated: a person told you. observed: you saw it in a file, ticket or tool result. " +
            "inferred: you concluded it. Be honest — an inferred record treated as fact is how " +
            "this stops being trusted.",
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
      "Returns only records that are still current — anything superseded by a later " +
      "record is left out. " +
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
      "Worth calling unprompted when someone asks what they should do next, or at " +
      "the start of a working session: the oldest blocked item is usually more " +
      "valuable to unstick than the newest thing to start. " +
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
      "Returns people rather than records, ranked by how recently they worked on it " +
      "— someone who did it once last week remembers it better than someone who did " +
      "it ten times last year. " +
      "This is about who has DONE the work. To find a reusable skill for doing it " +
      "yourself, use search_skills.",
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
      "Everything recorded since you last checked, oldest first, with a cursor to " +
      "pass back next time. Use at the start of a session to find out what changed " +
      "while you were away. " +
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

// ---------------------------------------------------------------------------
// Handler wiring
//
// Each of these needs a SQL function; queries.sql has the bodies. Sketched
// rather than implemented, because the signatures are the part worth agreeing
// before anything is written.
//
//   record_work    -> rpc("record_work", {...})     returns { ok, id, subject_used,
//                                                             similar_subjects[] }
//   find_work      -> rpc("find_work", {...})       returns record[]
//   whats_blocked  -> rpc("whats_blocked", {...})   returns record[] + waiting_on_name
//   who_worked_on  -> rpc("who_worked_on", {...})   returns { person, name, records,
//                                                             last_touched, subjects[] }[]
//   catch_up       -> rpc("catch_up", {...})        returns { records[], cursor }
//
// One thing worth building into record_work rather than leaving to discipline:
// it returns similar_subjects. The agent picked a subject blind, and the cheapest
// possible correction is telling it what already existed right after it guessed.
// SCHEMA.md flags subject sprawl as the failure that makes the workspace
// unqueryable while everything still looks fine; this is the counter-measure.
// ---------------------------------------------------------------------------
