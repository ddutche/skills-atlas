---
name: dependency-health
description: >
  Keeps a project's third-party packages current and free of known
  vulnerabilities instead of letting them silently rot. Use this skill when
  starting meaningful work in a repo that hasn't been touched in a while,
  when the user explicitly asks to check for updates, outdated packages, or
  security vulnerabilities, and whenever adding a new dependency to a
  project. Covers: running the right audit tool for the stack in use (npm,
  pip, etc.), prioritizing vulnerabilities by real severity and whether the
  affected code path is actually used, upgrading deliberately rather than
  bumping everything blindly, and vetting a package before adding it in the
  first place. Use this even if the user doesn't mention "security" or
  "dependencies" by name, for example when they ask you to add a library or
  say a project "hasn't been touched in a while."
---

# Dependency Health

## Why this exists

Dependencies are code you didn't write but are still responsible for. Left
alone, they accumulate known vulnerabilities and drift far enough behind that
upgrading later becomes its own project. Catching this early and often, in
small deliberate steps, is far cheaper than a forced, all-at-once upgrade
after something breaks or gets flagged.

## When to check

Not on every tiny edit, that would be noisy and slow things down for no
reason. Check when:

- Starting substantial work in a repo you (Claude) haven't touched recently,
  as a quick health check before diving in.
- The user explicitly asks about updates, outdated packages, or security
  issues.
- A new dependency is about to be added, check the ecosystem around it, not
  just the package itself.

## Running the check

Use whichever tool matches the project's stack:

- **Node/npm**: `npm outdated` for what's behind, `npm audit` for known
  vulnerabilities.
- **Python/pip**: `pip list --outdated`, and `pip-audit` if available (install
  it if not, it's a lightweight, well-established tool) for vulnerability
  scanning.
- Other ecosystems: use their standard equivalent (`cargo audit`,
  `bundle audit`, etc.) rather than trying to hand-check versions.

## Prioritizing what you find

Not every flagged issue deserves the same urgency. Weigh:

- **Severity** (critical/high vs low), as reported by the audit tool.
- **Reachability**: is the vulnerable code path actually exercised by this
  project, or is it a dev-only dependency, or a deeply nested transitive
  dependency whose vulnerable function is never called here? A critical
  vulnerability in unused code is lower priority than a moderate one in
  something the app calls directly.
- **Blast radius**: does this package touch auth, payments, or user data? Weigh
  those more heavily regardless of the tool's own severity label.

Report findings in plain language: what the risk actually is, roughly how bad
it would be if exploited, and what fixing it would involve, not just a raw
list of CVE identifiers.

## Upgrading deliberately

Don't blindly bump every outdated package to latest in one pass, especially
across major versions. For anything beyond a patch/minor bump:

- Skim the changelog or release notes for breaking changes.
- Upgrade and test in isolation where practical, so if something breaks, it's
  obvious which upgrade caused it, rather than debugging a pile of
  simultaneous version bumps.
- Lean on the verify-before-shipping skill afterward, an upgrade isn't done
  until the app is confirmed still working, not just installed.

## Before adding a new dependency

Pause for a second before pulling in a new package, since every dependency
added is now something to keep patched indefinitely. Quick gut checks:

- Is it actively maintained (recent commits/releases, not abandoned)?
- Does it have reasonable adoption (not a red flag by itself, but a
  near-unknown package for something a well-known library already does well
  is worth a second thought)?
- Does it need all the permissions/access it's asking for relative to what
  it's actually being used for?

This isn't about being paranoid over every install, most day-to-day packages
are fine, it's about not reaching for an obscure, unmaintained package when a
well-established one solves the same problem.
