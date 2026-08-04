---
name: verify-before-shipping
description: >
  Makes sure a code change actually works before it's called done, instead of
  relying on it looking correct. Use this skill whenever finishing a feature,
  bugfix, or other code change that's about to be reported as complete,
  committed, or opened as a pull request. Covers: running or exercising the
  change and showing real output rather than just claiming it works, adding a
  regression test for bug fixes so the same bug can't silently come back,
  adding proportionate test coverage for new features (more for things like
  payments, auth, or data-changing logic, less for a copy tweak), and running
  the broader test suite before a PR so a change doesn't quietly break
  something else. Use this even if the user doesn't explicitly ask for tests,
  since for someone who isn't reading every line of code themselves, this is
  the actual safety net.
---

# Verify Before Shipping

## Why this exists

Code that "looks right" and code that "works" are different claims. For
someone who isn't reading every line themselves, "I made the change" isn't
enough, there needs to be real evidence it does what it's supposed to do.
That evidence is what this skill produces: a test run, a script execution, an
API call and its response, not just a description of what the code should do.

## Before calling anything done

Don't report a change as complete without having verified it. What "verified"
means depends on what exists in the repo already:

- If there's an existing test setup (a test framework already in use), run
  the relevant tests and show the result. Don't just say "this should work."
- If there's no test framework yet, or the change doesn't lend itself to an
  automated test (a one-off script, a config tweak), actually run or exercise
  the change and show real output: hit the endpoint, run the script, load the
  page, execute the query. Evidence beats confidence.
- If genuinely nothing can be run or verified in this environment (say, a
  change that only matters in production infrastructure not accessible here),
  say so plainly rather than implying it was tested when it wasn't.

## Bug fixes get a regression test

When fixing a bug, add a test that reproduces the original broken behavior
and confirms it's now fixed. This is what actually prevents the same bug from
quietly coming back in six months when someone touches that code again
without knowing the history. A fix without a regression test is one refactor
away from breaking the same way twice.

## New features get proportionate coverage

Not everything needs the same amount of testing. Match the effort to the
cost of being wrong:

- **High stakes** (payments, auth, anything that writes or deletes user data,
  permissions/access control): cover the main path and the realistic edge
  cases (empty input, wrong type, unauthorized access, boundary values).
- **Low stakes** (copy changes, styling, a new read-only display): a quick
  manual check is usually proportionate, don't force a full test suite onto
  something trivial.

The goal is confidence proportionate to risk, not maximum test count.

## Before opening a pull request

Run the broader test suite, not just the new test for this change. New code
can break something unrelated in ways that only show up when the full suite
runs. If the suite is slow or partial runs are the norm in this repo, use
judgment, but a PR that's never been run against the existing tests is a PR
that hasn't actually been checked.

## Errors shouldn't disappear silently

A caught exception that gets swallowed (an empty `catch` block, an error
logged to a console nobody's watching) isn't handled, it's hidden. When
writing code that can fail, especially anything server-side or in a
background job, make sure the failure actually surfaces somewhere a human
would see it: a thrown error that shows up in logs/terminal output during
dev, a proper error boundary or user-facing message in the UI, or a real
monitoring tool (like Sentry) if one's already set up in the project. Don't
add a new monitoring dependency just to satisfy this, that's a call the
user makes deliberately, not something to slip in. The bar here is just:
if this breaks, will anyone find out, or will it fail quietly forever?

## Explaining results

When reporting what was verified, say it in plain terms, especially useful
alongside a pull request description (see the human-readable-changes skill):
"this test confirms that submitting the form with an empty email now shows an
error instead of crashing," not just "added test_empty_email, passing." The
point is that the person relying on this change, even if they don't code,
can tell what was actually checked.
