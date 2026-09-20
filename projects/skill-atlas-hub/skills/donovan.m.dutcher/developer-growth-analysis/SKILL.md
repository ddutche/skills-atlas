---
name: developer-growth-analysis
description: Analyzes a developer's recent Claude Code chat history to identify coding patterns, skill gaps, and areas for improvement, curates relevant learning resources via web search, and delivers a personalized growth report — to Slack DMs if a Slack connector is available, otherwise as a downloadable file. Use this when someone asks to review their recent coding work, get feedback on their development patterns, find their technical blind spots, or wants a "growth report" / "dev retro" style summary of what they've been building. Only works when run somewhere with access to the user's local Claude Code chat history file.
---

# Developer Growth Analysis

This skill provides personalized feedback on recent coding work by analyzing Claude Code chat history and identifying patterns that reveal strengths and areas for growth.

## When to Use This Skill

Use this skill when the user wants to:
- Understand their development patterns and habits from recent work
- Identify specific technical gaps or recurring challenges
- Discover which topics would benefit from deeper study
- Get curated learning resources tailored to their actual work patterns
- Track improvement areas across recent projects
- Get structured feedback on their growth without waiting for a code review

## Environment Check (Do This First)

This skill's whole value comes from reading real chat history, so before doing anything else, confirm the data actually exists in this environment:

1. Check whether `~/.claude/history.jsonl` exists and is readable. This file only exists in Claude Code CLI sessions running on the user's own machine — it will **not** be present in a cloud/Cowork session, a fresh container, or any environment that isn't the user's local Claude Code install.
2. If it exists, proceed with the analysis below.
3. If it doesn't exist, say so plainly rather than fabricating patterns, and offer the practical alternatives: run this skill from a local Claude Code session instead, or paste/describe recent work directly so an analysis can be done from that instead of file history.

## What This Skill Does

1. **Reads chat history**: Local Claude Code chat history from the past 24-48 hours (or whatever window the user specifies).
2. **Identifies development patterns**: Problem types, technologies, challenges, and approach style.
3. **Detects improvement areas**: Patterns suggesting skill gaps, repeated struggles, or inefficient approaches.
4. **Generates a personalized report**: Work summary, prioritized improvement areas, and concrete recommendations.
5. **Finds learning resources**: Curated articles/discussions relevant to each improvement area.
6. **Delivers the report**: To Slack DMs if a Slack connector is available and connected; otherwise as a file the user can open and keep.

## How to Use

```
Analyze my developer growth from my recent chats
```

Or scoped to a specific window:

```
Analyze my work from today and suggest areas for improvement
```

## Instructions

### 1. Access Chat History

Read `~/.claude/history.jsonl` (JSONL format, one entry per line):
- `display`: the user's message/request
- `project`: the project being worked on
- `timestamp`: Unix timestamp in milliseconds
- `pastedContents`: any code or content pasted

Filter for entries in the requested window (default: past 24-48 hours) based on the current timestamp.

### 2. Analyze Work Patterns

From the filtered chats, extract:
- **Projects and domains**: backend, frontend, DevOps, data, etc.
- **Technologies used**: languages, frameworks, tools that appear
- **Problem types**: performance work, debugging, feature implementation, refactoring, setup/config
- **Challenges encountered**: repeated questions on similar topics, problems that took multiple attempts, questions signaling a knowledge gap, complex architectural decisions
- **Approach patterns**: methodical, exploratory, experimental

### 3. Identify Improvement Areas

Pick 3-5 areas that are:
- **Specific** (not "improve coding skills")
- **Evidence-based** (grounded in the actual chat history)
- **Actionable**
- **Prioritized** by impact

Examples of good improvement areas:
- "Advanced TypeScript patterns (generics, utility types, type guards) — type safety issues came up repeatedly in [specific project]"
- "Error handling and validation — several bug fixes traced back to missing null checks"
- "Async/await patterns — recent work shows some race conditions and timing issues"
- "Database query optimization — the same query was rewritten multiple times"

### 4. Generate the Report

```markdown
# Your Developer Growth Report

**Report Period**: [Yesterday / Today / Custom Date Range]
**Last Updated**: [Current Date and Time]

## Work Summary

[2-3 paragraphs: what was worked on, projects touched, technologies used, overall focus]

## Improvement Areas (Prioritized)

### 1. [Area Name]

**Why This Matters**: [Why this skill matters for this person's actual work]

**What I Observed**: [Specific evidence from chat history]

**Recommendation**: [Concrete next step(s)]

**Time to Skill Up**: [Rough effort estimate]

---

[Repeat for 2-4 additional areas]

## Strengths Observed

[2-3 bullet points on what's going well]

## Action Items

Priority order:
1. [From highest priority improvement area]
2. [From next area]
3. [From next area]

## Learning Resources

[Populated in the next step]
```

### 5. Find Learning Resources

Use the web search tool to find high-quality, relevant articles for each improvement area — Hacker News discussions are a good source of vetted, discussed technical writing (search `site:news.ycombinator.com [topic]`, or search the topic directly and favor results that are HN-discussed or otherwise well-vetted), but don't limit to HN if better sources turn up. For each area, include 2-3 of the most relevant, with title, rough date, a one-line note on why it's relevant, and a link.

```markdown
## Curated Learning Resources

### For: [Improvement Area]

1. **[Article Title]** - [Date]
   [Why it's relevant to this improvement area]
   [Link]

2. **[Article Title]** - [Date]
   [Description]
   [Link]

[Repeat for other improvement areas]
```

### 6. Deliver the Report

Check whether a Slack connector is available and connected (search the connector registry if unsure). If so, offer to send the report to the user's own Slack DMs, formatted as a well-structured message broken into logical sections (Summary, Improvements, Strengths, Actions, Resources) with clickable resource links, and confirm delivery.

If no Slack connector is available or connected, don't block on it — deliver the report as a file instead so the user has something to keep and reference, and mention that connecting Slack would let this go straight to DMs in the future.

Either way, if this is something the user wants regularly (e.g. "run this every week"), offer to set it up as a recurring scheduled task instead of them having to ask each time.

## Example Output

```markdown
# Your Developer Growth Report

**Report Period**: November 9-10, 2024
**Last Updated**: November 10, 2024, 9:15 PM

## Work Summary

Over the past two days, work focused on backend infrastructure and API development for an open-source showcase application — connections management, UI improvements, and deployment configuration, using TypeScript, React, and Node.js. The work balanced feature delivery with addressing technical debt.

## Improvement Areas (Prioritized)

### 1. Advanced TypeScript Patterns and Type Safety

**Why This Matters**: TypeScript is central to this work, but leaning on advanced features (generics, utility types, conditional types, type guards) catches more bugs at compile time instead of in production.

**What I Observed**: Connection data structures needed a few passes to type auth configurations correctly, and union types for connection states went through several iterations — a good fit for discriminated unions and type guards.

**Recommendation**: Study utility types (Omit, Pick, Record), conditional types, and discriminated unions; apply them to connection configuration and auth state handling.

**Time to Skill Up**: 5-8 hours

### 2. Secure Data Handling in the UI

**Why This Matters**: A recent fix caught sensitive connection data being displayed in the console — preventing that kind of leakage matters for anything handling credentials or API keys.

**What I Observed**: The "Your Apps" page was showing full connection data including auth configs before the fix — good instinct to catch it; worth turning into a default habit.

**Recommendation**: Build a reusable pattern for filtering/masking sensitive fields before display, so it's structural rather than something to remember to catch each time.

**Time to Skill Up**: 3-4 hours

## Strengths Observed

- Proactively caught a data-leakage issue before it shipped
- Worked through UI requirements methodically, asking clarifying questions along the way
- Comfortable moving across backend, frontend, and deployment concerns

## Action Items

1. Learn TypeScript utility types and discriminated unions; apply to connection data structures
2. Document which fields are safe to display and build a masking helper for the rest
3. Read one article on advanced React patterns and apply one pattern to current UI work

## Curated Learning Resources

### For: Advanced TypeScript Patterns

1. **TypeScript's Advanced Types: Generics, Utility Types, and Conditional Types** - Oct 2024
   Practical coverage of discriminated unions and type guards for compile-time safety.
   [link]

### For: Secure Data Handling in the UI

1. **Preventing Information Leakage in Web Applications** - Aug 2024
   Filtering sensitive fields, secure logging, and audit trails.
   [link]
```

## Tips and Best Practices

- Run this weekly to track improvement over time — consider setting it up as a recurring scheduled task rather than remembering to ask
- Focus on one improvement area at a time rather than all of them at once
- Use the learning resources as a study guide, not just a reading list
- Revisit the report after a week of focus to see how patterns shift
- Recommendations are grounded in real chat history, so they'll be more specific than generic "learn X" advice — lean into that specificity when writing them

## How Accuracy and Quality Are Maintained

- Grounded in actual, timestamped chat history — not guesswork
- Recommendations tied to specific evidence from the history, cited in the report
- Learning resources matched to identified gaps, not generic topics
- Focused on actionable improvements with realistic time estimates
- Prioritized by likely impact on development velocity
