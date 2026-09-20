#!/usr/bin/env python3
"""
Builds the update zip that the hub installs by itself.

Run it from anywhere:

    python repo/tools/make-update/make-update.py

It writes update-YYYY-MM-DD-HHMM.zip next to the repo. Upload that to the hub
folder in Drive and the five-minute trigger picks it up. Nothing else to press.

Why a script rather than zipping the folder by hand:

  * The zip must be built with forward slashes. A zip made by PowerShell's
    Compress-Archive uses backslashes, and every file then lands flat in the
    hub root with its whole path as its name.

  * Only the files the hub actually wants may go in. The hub root already holds
    a file called Code.gs, and it is the live Apps Script project, not text.
    A build carrying its own Code.gs at the root collides with it, and Drive
    reports that as "Access denied", which reads like a permissions problem and
    is not one. The canonical copy lives at tools/apps-script/Code.gs.

  * atlas.html ships as the template, not as a generated page. The Apps Script
    splices current data into it on every build, so shipping a generated copy
    just carries 80KB of data that is thrown away on arrival.
"""

import datetime
import pathlib
import sys
import zipfile

HERE = pathlib.Path(__file__).resolve()
REPO = HERE.parents[2]                    # the repo root, .../skill-atlas
ROOT = REPO                               # where the built zip is written

# Everything in the zip is prefixed with this, which the installer strips.
PREFIX = "skill-atlas/"

# repo path -> path inside the hub.
#
# A mapping rather than one list, because the repo is no longer laid out the
# same way as the hub. The repo groups by what a file IS (web, apps-script,
# supabase); the hub groups by where the Apps Script installer expects to find
# it. Naming both ends means renaming a repo folder cannot silently move a file
# in the hub, or silently stop shipping it.
#
# Named one by one rather than globbed, so a scratch file left in the repo
# cannot ride along into the hub.
FILES = {
    "web/atlas.html":                        "atlas.html",
    "web/hub.json":                          "hub.json",
    "README.md":                             "README.md",
    "apps-script/Code.gs":                   "tools/apps-script/Code.gs",
    "apps-script/DEPLOY.md":                 "tools/apps-script/DEPLOY.md",
    "tools/generate-atlas/generate-atlas.mjs": "tools/generate-atlas/generate-atlas.mjs",
    "tools/install-skill/SKILL.md":          "tools/install-skill/SKILL.md",
    "tools/publish-skills/SKILL.md":         "tools/publish-skills/SKILL.md",
    "tools/make-update/make-update.py":      "tools/make-update/make-update.py",
    "lucid/lucid-export.mjs":                "tools/lucid-export/lucid-export.mjs",
    "lucid/PUSH.md":                         "tools/lucid-export/PUSH.md",
}

# Inside a skill folder. A skill needs SKILL.md; the rest are optional.
SKILL_FILES = ["SKILL.md", "about.md", "diagram.mmd", "diagram.svg"]


def check_template(path):
    """A page without its markers would serve the same stale data forever."""
    text = path.read_text(encoding="utf-8")
    if "/* @data:start */" not in text or "/* @data:end */" not in text:
        sys.exit("atlas.html has lost its @data markers, so the hub could not "
                 "splice current data into it. Not packaging.")
    return len(text)


def main():
    # Skills are not part of this repo. They belong to whoever wrote them and
    # live wherever that person keeps them, so the corpus is an argument rather
    # than a checked-in folder. Without one, this packages the engine alone,
    # which is exactly what a first install needs.
    SKILLS = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else None
    if SKILLS and not SKILLS.is_dir():
        sys.exit("Not a directory: " + str(SKILLS))

    missing = [f for f in FILES if not (REPO / f).is_file()]
    if missing:
        sys.exit("Missing from the repo: " + ", ".join(missing))

    check_template(REPO / "web" / "atlas.html")

    stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M")
    out = ROOT / ("update-" + stamp + ".zip")

    added = []
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for src, dest in FILES.items():
            z.write(REPO / src, PREFIX + dest)
            added.append(dest)

        if not SKILLS:
            print("No skills directory given, packaging the engine only.")
            print("Pass one to include skills:  python make-update.py path/to/skills")

        if SKILLS and (SKILLS / "README.md").is_file():
            z.write(SKILLS / "README.md", PREFIX + "skills/README.md")
            added.append("skills/README.md")

        for person in sorted(p for p in (SKILLS.iterdir() if SKILLS else []) if p.is_dir()):
            profile = person / "profile.json"
            if profile.is_file():
                rel = "skills/" + person.name + "/profile.json"
                z.write(profile, PREFIX + rel)
                added.append(rel)

            for skill in sorted(s for s in person.iterdir() if s.is_dir()):
                if not (skill / "SKILL.md").is_file():
                    print("  skipped " + person.name + "/" + skill.name +
                          " (no SKILL.md)")
                    continue
                for name in SKILL_FILES:
                    f = skill / name
                    if f.is_file():
                        rel = "skills/" + person.name + "/" + skill.name + "/" + name
                        z.write(f, PREFIX + rel)
                        added.append(rel)

    print(str(len(added)) + " files -> " + out.name +
          " (" + str(out.stat().st_size // 1024) + "KB)")
    return out


if __name__ == "__main__":
    main()
