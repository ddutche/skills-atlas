# Changelog

## 2026-08-04 (later)
Removed the `global-skills/` copies added earlier today. They were copies of the skills in the home folder, which meant edits made through Skill Atlas never reached the skills Claude actually loads, and the two sets had already drifted apart. Those skills now live in their own repo (`claude-skills`) that is versioned in place, so this copy is no longer needed.


## 2026-08-04
Added copies of the five general-purpose Claude skills (dependency health, human-readable changes, secrets and env safety, Railway, verify before shipping) under a new `global-skills/` folder, so they show up in Skill Atlas alongside the intel-hub ones. These are copies for viewing and backup, the live versions Claude actually loads still live in the home folder.

## 2026-08-02
Put intel-hub under version control for the first time. Nothing about the project changed, this just makes sure the knowledge base, playbooks, and the 5 skills that run this pipeline (sorting the inbox, extracting insights, refreshing research, turning patterns into playbooks, and producing outward-facing output) are backed up and tracked on GitHub instead of only living on one machine.
