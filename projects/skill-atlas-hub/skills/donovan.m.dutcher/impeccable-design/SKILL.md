---
name: impeccable-design
description: Use whenever creating or reshaping user-facing UI, landing pages, dashboards, or components. Steers away from the recognizable "AI-generated" look without prescribing a fixed palette or font — names what the surface is for, works within (or defines) an actual design system, and checks the result against a catalog of known AI-slop tells and general quality defects.
---

# Impeccable Design Guidance

This is not a rulebook of "use these colors, use this font." It's a way of noticing when a design choice was reached for by default instead of decided on purpose. A purple gradient isn't wrong because purple is banned — it's wrong when it's the thing every model reaches for without thinking. The same choice, made deliberately and for a reason you could name, is fine. The goal is a considered decision at every step, not compliance with a fixed aesthetic.

## Step 1 — Name what the surface is for

Before anything visual, say which of these the page is doing. It changes what's appropriate — a bold hero is right for one and wrong for another:

- **Persuade** — a landing or marketing page. Job: win attention, make a sharp idea unmissable.
- **Operate** — a dashboard or tool. Job: help someone complete a task, fast, often under pressure.
- **Read** — documentation or long-form content. Job: build understanding, get out of the way.
- **Experience** — a portfolio, brand site, or anything where the work itself is the point. Job: let the work lead.

A dashboard designed like a landing page (giant hero metric, marketing copy) and a landing page designed like a dashboard (cautious, dense, no persuasion) are both the same mistake: the mode wasn't named first.

## Step 2 — Work from an actual design system, not the aggregate default

If the project already has one — tokens, existing components, a brand file, a style already established elsewhere in the codebase — inherit it. Match the existing fonts, colors, radii, and spacing instead of introducing new ones that happen to be whatever's typical.

If there isn't one yet, write down the real, specific decisions before building anything:

```
Fonts:      [exact names — display / body / mono if needed]
Palette:    [named hex values with a role for each — not "blue," #____]
Radius:     [the actual scale in use, e.g. 4 / 8 / 16, or 0]
Spacing:    [the actual scale in use]
Who's reading this, in what state of mind:
What this surface should never look or sound like:
```

This isn't a permanent style guide — it's just this project's decisions, written down so the fifth screen matches the first instead of drifting toward the defaults below. Vague or missing values are what let a model's aggregate training-data average leak back in.

## Step 3 — Check against what's recognizable as AI-generated

These are tells: patterns so common in AI output that their presence alone reads as "not designed," regardless of what page they're on. Treat this as a thing to notice and steer around, not a list of forbidden ingredients — the difference between a mistake and a choice is whether you could say why you did it.

**Visual details**
- A decorative grid-line texture covering a surface with nothing measurable happening on it
- A thick colored border on one side of a rounded card — the single most recognizable AI tell there is
- A hairline border *and* a wide soft shadow on the same element — commit to a defined edge or a soft elevation, not both
- Frosted-glass blur used as decoration rather than to solve a real layering problem
- Repeating-gradient stripes as surface texture
- Cards rounded into a soft blob (24px+ on something small) — cards generally top out around 12–16px; save full-pill shapes for tags and buttons
- A hand-coded SVG mascot or scene standing in for real illustration

**Typography**
- A tracked-uppercase kicker/eyebrow sitting above a heading, borrowing editorial authority it hasn't earned
- Font sizes too close together with no real hierarchy (aim for at least 1.25x between steps)
- A small rounded-square icon stacked above a heading — the universal feature-card template every generator outputs
- An oversized italic serif hero headline — has a real editorial use, but as a reflex it's the current default AI-startup hero
- A full-sentence headline blown up to display size (a punchy word or two at that size is fine; the problem is length at that scale)
- Letter-spacing crushed tight enough that characters lose their own shape
- Inter, Geist, Space Grotesk, or Instrument Serif reached for as the default rather than chosen on purpose
- One font doing every job on the page, with no display/body contrast
- Long passages set in all-caps (fine for short labels, hard to read at length — we recognize words by shape, and caps remove it)

**Color & contrast**
- A saturated radial glow behind a section, or an ambient halo on a dark page
- Purple/violet gradients and cyan-on-dark — the most recognizable AI palette
- Dark mode with colored glow shadows as the default "cool" look
- Gradient text on headings or metrics
- Gray text on a colored background (washed out — use a darker shade of the same hue, or true white)
- Warm cream/beige reached for as the safe "tasteful" background instead of a background that actually comes from the palette in use

**Layout & space**
- Tiny numbered labels (01 / 02 / 03) next to headings that aren't actually sequential — let rhythm and hierarchy do the organizing instead
- The hero-metric template: big number, small label, three supporting stats, gradient accent
- Identical card grids — same size, icon + heading + one line, repeated endlessly
- One spacing value used everywhere, with no tight-near / generous-far rhythm
- Cards nested inside cards inside cards
- Text lines wider than ~75 characters (the eye loses its place tracking back)
- Content overflowing its container, or a positioned child (menu, tooltip) clipped by an overflow wrapper

**Motion**
- A pulsing dot on status that isn't actually live data
- A fake blinking cursor on copy that isn't an editable input
- An auto-scrolling marquee that won't let someone read at their own pace
- Bounce/elastic/spring easing on interface elements (save spring physics for things that are actually physical)
- Animating width/height/padding/margin instead of transform/opacity (causes layout jank as a side effect, independent of the aesthetic issue)
- Images that scale or rotate on hover by default

**Copy**
- More than a couple of em-dashes in body copy
- Marketing buzzwords — streamline, empower, supercharge, world-class, enterprise-grade — standing in for what the product actually does
- The aphoristic "Not X. Y." cadence (fine once; a pattern when repeated)
- Dismissing something as "theater" instead of saying plainly what it does or doesn't do
- The same message restated across label, sublabel, and helper text

**Imagery**
- Hero art assembled from generic SVG shapes, reading as placeholder clip art
- Empty, missing, or placeholder `src` values shipping as broken-image boxes

**General quality** — these hurt regardless of whether AI wrote the page, worth the same pass:
- Functional text under 11px; body text under 12–14px
- Line-height below 1.3–1.5x on multi-line text
- Cramped padding inside bordered or colored containers (under ~8–16px)
- Body text flush against the viewport edge with no container padding
- Justified text without hyphenation
- Text failing WCAG AA contrast (4.5:1 body, 3:1 large text)
- Skipped heading levels (h1 straight to h3)
- Wide letter-spacing (>0.05em) on body text instead of short labels only

## Step 4 — Judge by mode, not by checklist alone

A pattern being on this list doesn't make every instance of it wrong — it means it needs a reason. An eyebrow label might genuinely work as a breadcrumb. A hero metric might be exactly right for an *Operate* summary screen. The check is always: would this exact choice survive being asked "why this, specifically, here?" If the honest answer is "it's what usually gets used," that's the tell — revise it. If the answer names something about this product, this audience, or this content, it's a decision, not slop, and it stays.
