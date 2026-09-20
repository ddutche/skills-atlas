# Changelog

## 2026-09-19
Put the Skill Atlas and the shared team memory design under version control. Until now all of it, the atlas itself, the tool that builds it, every design document, and the database plan, lived in one folder on one laptop with no backup anywhere. That included the written record of what had already been tried and what broke, which is the expensive part to lose.

The old employer-branded copy of the hub was deliberately left out and is now ignored by git, so it cannot be added by accident later. It stays on the machine, it just does not go into this repository.

## 2026-08-10
Fixed the skills atlas credential check, which was refusing to publish the one skill about keeping credentials out of code. That skill shows a fake database password and an empty private-key header as examples of what to watch for, and the check could not tell an example from the real thing. It now looks at the value it found, not just the shape: a placeholder password or a bare header goes through, a generated-looking password or an actual key body still stops the publish. All eleven skills now pass, and there is a test that proves both halves of that so the check cannot quietly go soft later.

Also confirmed that Lucid write access is really working, by creating a diagram and then adding, editing, and deleting a shape on it. That last part matters: the visual atlas can be kept up to date in place instead of being replaced by a new copy with a new link every time it refreshes.

Built the piece that works out what to change in the Lucid diagram when the skill list changes, so a refresh only touches what actually moved instead of rebuilding everything. It deliberately never touches anything a person added to the diagram themselves, and it puts back any box someone deletes by accident. Also fixed two things that made the diagram look wrong: box labels ran together onto one line, and text was a different size in every box.

Found a hard limit while checking the plan to have this run automatically on a schedule: Lucid's web interface for other programs can create a diagram but cannot change one that already exists. The editing we proved working goes through a different route that only runs when someone asks Claude to do it. That matters because the whole point was for this to keep running after Donny leaves in September, so it needs a decision rather than more code.

## 2026-08-04 (later)
Removed the `global-skills/` copies added earlier today. They were copies of the skills in the home folder, which meant edits made through Skill Atlas never reached the skills Claude actually loads, and the two sets had already drifted apart. Those skills now live in their own repo (`claude-skills`) that is versioned in place, so this copy is no longer needed.


## 2026-08-04
Added copies of the five general-purpose Claude skills (dependency health, human-readable changes, secrets and env safety, Railway, verify before shipping) under a new `global-skills/` folder, so they show up in Skill Atlas alongside the intel-hub ones. These are copies for viewing and backup, the live versions Claude actually loads still live in the home folder.

## 2026-08-02
Put intel-hub under version control for the first time. Nothing about the project changed, this just makes sure the knowledge base, playbooks, and the 5 skills that run this pipeline (sorting the inbox, extracting insights, refreshing research, turning patterns into playbooks, and producing outward-facing output) are backed up and tracked on GitHub instead of only living on one machine.
