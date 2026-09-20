# Standing this up on your own accounts

Written for a fresh start on a personal Google account and a personal Supabase
account. Nothing here depends on the deployment this came out of.

Do part 1 and stop. It gets you a working atlas. Parts 2 and 3 are only worth
doing once enough people are using it that Drive round trips start to hurt.

---

## Part 1 — the atlas, on Drive and Apps Script

About fifteen minutes, no cost, nothing to maintain.

1. **Make the hub folder.** In Google Drive, create a folder — call it whatever
   `HUB_NAME` will say. Take the id from its URL, the part after `/folders/`.

2. **Put the two files in it.** Upload `web/atlas.html` and `web/hub.json` to
   the folder root. Edit `hub.json` first if your teams are not the default set;
   the atlas builds its filters and its upload form from that list.

3. **Make the script.** Go to script.google.com, new project, and paste
   `apps-script/Code.gs` over the whole of `Code.gs`.

4. **Set the two values at the top.** `HUB_FOLDER_ID` to the id from step 1, and
   `HUB_NAME` to whatever the hub is called. If you skip `HUB_FOLDER_ID`, the
   deployed page tells you so by name rather than failing obscurely.

5. **Deploy.** Deploy → New deployment → Web app.
   - **Execute as: User accessing the web app.** This is not optional. Under
     "Me", `Session.getActiveUser().getEmail()` returns blank for everyone but
     you, which means nobody can be identified, nobody can publish to their own
     folder, and nobody can delete anything.
   - **Who has access:** restrict to your domain if you have a Workspace
     domain. That single setting is the entire access control story, and it is
     the reason this design works without building auth.

6. **Open the URL.** An empty hub renders an empty atlas. Publish something
   through the page and it appears.

### Two things that will bite you

**Do not add a `bustCache()` call to `saveLayout`.** It was there originally.
`saveLayout` fires automatically after every drag, and `bustCache` deletes the
built index, so moving one box made the next visitor — anyone in the company —
rebuild the entire hub from Drive. It was the single largest cause of slow page
loads and it is not obvious from reading either function alone.

**`Code.gs` at the hub root is the live script project, not a text file.**
Writing to it throws "Access denied: DriveApp", which reads like a permissions
problem and is not one. `isReserved()` already skips it. Leave that alone.

---

## Part 2 — Supabase, if and when you need it

Only worth doing past a few hundred skills, or when you want the MCP.

1. **Create a project** at supabase.com on the account you want to own this
   long term. Ownership is the whole point of doing this deliberately: the
   previous deployment died because the project sat on an account that was
   going to be deprovisioned.

2. **Apply the migrations in `supabase/migrations/` in filename order.** They
   are numbered and they depend on each other.

3. **Check the grants afterwards. Do not skip this.**

   ```sql
   select p.proname, array_to_string(p.proacl::text[], ' | ') as acl
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' order by p.proname;
   ```

   Every row must read `postgres=X/postgres | service_role=X/postgres` and
   nothing else. If you see `anon=X` on `publish_skill`, anyone holding the
   publishable key can write skills straight into your database, bypassing the
   scanner entirely. This happened in the original deployment and survived a
   migration that was written specifically to prevent it, because Supabase
   grants EXECUTE on new functions to `anon` **by name** through default
   privileges — so revoking from `PUBLIC` alone, which is the correct fix on
   stock Postgres, silently does nothing. The last migration fixes both halves.
   The database linter also missed it. Read `proacl` yourself.

4. **Deploy the Edge Function** in `supabase/functions/hub/` with
   `verify_jwt: false` — it does its own auth. Set `HUB_TOKEN` as a secret
   first: a generated random string, not any kind of key.

5. **Run the scanner test before touching the function**, every time:

   ```bash
   node --experimental-strip-types supabase/test/scan.test.mjs
   ```

   It lifts the block between `// SCANNER-START` and `// SCANNER-END` out of
   `index.ts` verbatim and runs that, so the thing tested is the thing that
   ships. Do not move or rename those markers; the test hard-fails without them.

---

## Part 3 — the honest weak points

Fix these before letting anyone outside a small trusted group publish.

**`HUB_TOKEN` is one shared secret.** Every person's Claude holds the same
string, and `X-Hub-User` is a header the caller sets, so it is an assertion and
not proof. Good enough to attribute a publish and keep an audit trail. Not good
enough to authorise anything, and it cannot be revoked for one person. Real
per-user auth — Supabase Auth with a Google provider, gated on your email
domain, with row-level security on `author` — replaces this, gives you
per-person delete for free, and is the single highest-value thing left to build.

**`sanitizeSvg` in `Code.gs` is a blocklist.** It strips `<script>`, `on*=`
handlers and XML declarations, and its output is injected straight into the
page. It does not stop `<foreignObject>`, `xlink:href="javascript:"`,
`<animate>`, or `<style>`. Anyone who can write a `diagram.svg` into the hub can
get script into the atlas, and script in that page can call `google.script.run`
as whoever is looking at it — publishing or deleting as them. Either render
diagrams in a sandboxed iframe, or drop `diagram.svg` support and keep only the
Mermaid path, which is hand-rendered and escapes its labels.

**Nothing scans the Apps Script publish path.** `publishSkills()` in `Code.gs`
has no content check at all. The scanner only exists in the Edge Function, so
until part 2 is done and publishing goes through it, everything arrives
unchecked.

**Profile writes have no locking.** `saveLayout`, `recordSave`, `publishSkills`
and `deleteSkill` all read-modify-write the same `profile.json` with no
`LockService`. Autosave-on-drag makes collisions routine rather than rare.
