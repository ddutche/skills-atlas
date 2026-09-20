# Deploying the live atlas

This turns the hub into a web page at a real company-only URL that is always
current. It reads the Shared Drive every time someone opens it, so a skill
added five minutes ago is already there. Nothing to regenerate.

Free, no hosting, no IT ticket. Takes about ten minutes.

## Create it inside the Shared Drive

**This is the one thing to get right.** Create the Apps Script project *in the
Shared Drive*, not in anyone's personal Drive. Then the organisation owns it,
exactly like the files, and it never has to be moved or recreated, which means
the URL never changes and nobody's bookmark ever breaks.

## Steps

1. Open the **Shared Drive** in Google Drive.
2. **New → More → Google Apps Script.** If that entry is missing, use
   *New → More → Connect more apps* and add Apps Script first.
3. Rename the project (top left) to **Skill Atlas**.
4. Delete the sample `myFunction` stub and paste in the contents of this
   folder's `Code.gs`.
5. Check `HUB_FOLDER_ID` near the top. It ships already set to the Shared
   Drive's id, so normally there is nothing to do. If the hub ever moves, the
   id is the part of the folder's URL after `/folders/`:

   ```
   https://drive.google.com/drive/folders/0AIzpSLfG7BzUUk9PVA
                                          ^^^^^^^^^^^^^^^^^^^ this
   ```

   **If you ever repaste this file, re-check this line.** Overwriting it with a
   placeholder makes every function fail in a way that looks like a broken
   script rather than a missing setting.

6. Save.
7. **Deploy → New deployment**. Click the gear, choose **Web app**, then set:
   - **Execute as:** Me *(see below, and note who should do this)*
   - **Who has access:** Anyone within your company
8. Click Deploy. Google asks you to authorise Drive access, because the script
   reads and writes the hub folder. Approve it. If it warns that the app is not
   verified, that is expected for an internal script: Advanced → Go to project.
9. Copy the **Web app URL**. That is the link you share.
10. Open it and check three things: the atlas loads, the Copy button on a skill
    still works (the Apps Script frame is exactly where the clipboard can be
    blocked), and Save arrangement on the Map view reports success.

## Execute as: which to choose

The atlas both reads and writes. Saving an arrangement or publishing skills
writes back to the Drive, so this setting is a real decision.

**Me** (what this hub currently uses). Nobody sees a Google consent screen, so
the first visit is a single click. The costs: every write is recorded as the
deployer, so revision history cannot tell you who changed what, and **anyone who
can open the page can also write**, regardless of their Drive role. Access is
still limited to company accounts.

There is a third cost, and it is the one people notice. Under this setting the
script cannot see who anyone is except the deployer, so for everybody else
"Only mine" is hidden, delete is hidden, and publishing cannot fill in their
name. They can read the whole atlas and copy anything; they just arrive
anonymous.

**User accessing the web app.** Each person's own Drive access applies, so Drive
roles become the permission model for free: Contributors can publish, Viewers can
only read. Edits are attributed to whoever made them, and the upload form can
fill in someone's identity instead of asking them to type their name. Everyone
gets "Only mine", their own saved arrangement, and the ability to delete their
own skills. The cost is a one-time Google authorisation screen per person.

Start with "Me" for the lowest-friction launch. Switch later if you want
attribution or want to stop everyone being able to write. It is one setting and
a new version of the same deployment, and the URL does not change.

## Important: who deploys, and what happens in September

With **Execute as: Me**, the web app runs using the Drive access of *whoever
created that deployment*. If that account is ever disabled, the atlas stops
working.

So the sequence is:

1. **Whoever is building it deploys first**, to find whatever actually goes
   wrong: policy blocks, quotas, whether the Copy button still works inside the
   Apps Script frame.
2. **Before that person's account can go away, someone permanent updates the
   existing deployment.** Deploy → Manage deployments → pencil icon → Version:
   New version → Deploy. From then on it runs as them, and the atlas no longer
   depends on an account that might be deprovisioned.

This is not a formality. The original deployment was tied to a contractor's
account with a known end date, and every architectural decision in this project
ended up bending around that one fact.

**Update the existing deployment. Do not create a second one.** Updating keeps
the same URL, so every bookmark and every Slack link keeps working. Creating a
new deployment produces a new URL and quietly strands everyone on the old one.

Because the script project lives in the Shared Drive, the project itself is owned
by the organisation throughout. Only the deployment identity changes hands.

## How someone is recognised

A profile is matched to a person by the `email` line in their `profile.json`.
Publishing writes that line automatically, so anyone who publishes through the
page is recognised from then on.

A folder seeded by hand is the exception. Without an `email` line nothing links
it to a Google account, so its owner is treated as a new person and ends up with
a second folder named after their address. If you create a folder by hand, put
the address in:

```json
{ "display_name": "Jane Smith", "email": "jane.smith@example.com", "team": "Sales" }
```

Deleting is gated on the same match, in the script rather than in the page: the
folder name has to equal the folder the signed-in address maps to. There is no
admin override and nothing you can type to get around it.

## Updating the hub with a new build

Once the script exists you never have to replace files by hand again.

**Automatic (recommended).** Run **createUpdateTrigger** once from the function
dropdown. From then on, any file named `update-*.zip` dropped into the hub is
unpacked within five minutes and then trashed. Nobody presses anything, which
means whoever is shipping changes can push them without you in the loop.

The name has to be unique each time (`update-2026-08-06-1530.zip`) because most
Drive integrations cannot replace a file, only add one. A fixed name would pile
up duplicates.

**Manual.** Drop `skill-atlas.zip` in and run **installFromZip** yourself.

**Two forms are accepted.** A `.zip` for anything large, and a `.json` manifest
shaped `{ "files": { "path/name.md": "contents" } }` for text-only changes.
The manifest exists because an integration that cannot replace a file can still
*create* one, and plain text is the only form it can push without base64
encoding. Small content and documentation updates travel that way; anything the
size of `atlas.html` still arrives as a zip somebody drops in.

Either way:

It unpacks the zip over the hub, updating each file **in place** and creating
folders as needed. Nothing is deleted, so a partial zip cannot wipe anyone's
published skills, and paths that try to escape the hub are refused.

This exists because uploading through a Drive integration *adds* a second file
with the same name rather than replacing the first. Two files called
`atlas.html` in one folder makes every by-name lookup ambiguous, and the page
people get becomes a coin flip. Apps Script can update in place; almost nothing
else can.

If you ever need to clear stray files from the hub root, `tidyHubRoot(['name'])`
trashes them by exact name, and `cleanupFlatFiles()` clears the wreckage of a
failed unpack.

**A file that will not write does not abandon the rest of the update.** The rest
of the zip still lands, the zip stays in the hub instead of being trashed, and
the log names exactly which files are outstanding. The next run picks it up. An
earlier version stopped at the first refusal and left the hub half updated,
which is worse than either finishing or not starting.

Turn it all off again with **removeUpdateTrigger**.

Note this only reloads files from the zip. Changes to `Code.gs` itself still
need a redeployment, below.

### Two names an update can never write

`Code.gs` at the top of the hub is the live script project. It is a Google file
with no text body, so writing over it fails, and Drive reports that as "Access
denied", which reads like a permissions problem and is not one. `Code.gs` is
also the one file here that has to change by pasting into the script editor, so
an update carrying a copy of it would not help even if it worked.

`skill-atlas.zip` is a package sitting in the hub, not part of the hub.

Both are skipped, so a build that includes them by mistake still installs.

### Building the update zip

Use `tools/make-update/make-update.py`. It names the files that belong in the
hub one by one rather than zipping a folder, which keeps two problems out:

```bash
python repo/tools/make-update/make-update.py
```

Do not use PowerShell's `Compress-Archive`. It writes backslashes as the path
separator, and every file then lands flat in the hub root with its whole path as
its name. `cleanupFlatFiles()` clears that up if it has already happened.

Ship `atlas.html` as the template out of `repo/`, not a page produced by
`generate-atlas.mjs`. The script splices current data into the template on every
build, so a generated copy just carries data that is discarded on arrival.

## After you change Code.gs

Edits do not go live on their own. **Deploy → Manage deployments → edit the
existing deployment → New version → Deploy.** Creating a *new* deployment
instead gives you a second URL, which is the usual way people end up with two
atlases and confusion about which is real.

## Things worth knowing

**It caches for five minutes.** Reading a folder full of files is slow, so a
built page is reused briefly. If someone publishes and wants to see it
immediately, add `?refresh=1` to the URL. Change `CACHE_SECONDS` in the script
if five minutes is the wrong trade for you.

**It reads and writes.** Saving an arrangement writes `layout.json`; publishing
from the page writes into `skills/<person>/`. Both go through validation in
`Code.gs` and both update files in place rather than creating duplicates. Drive
keeps revision history on everything they touch, so a bad write is recoverable
from the file's own version list.

**The presentation lives in `atlas.html`, not in the script.** The script reads
that file from the Drive as its template and fills in the data. If you want to
change how the page looks, edit `atlas.html`. No redeployment needed.

**If it breaks, nothing is lost.** The skills are ordinary files in the Shared
Drive. Anyone can open the folder and read or download them directly, and the
Node generator in `tools/generate-atlas/` still produces a static `atlas.html`
that works offline.

## Keeping the two generators in step

`Code.gs` and `tools/generate-atlas/generate-atlas.mjs` do the same job in two
runtimes: read the folder, build the data, splice it into `atlas.html` between
the `@data` markers. The script serves it live; the Node version writes a static
snapshot you can download and open offline.

**If you change how a skill is read, change it in both.** That is the one real
maintenance cost of this design, and it was a deliberate trade for not having a
server. They were verified to produce byte-identical data when written.
