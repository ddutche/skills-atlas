---
name: lead-research-assistant
description: Identifies and prioritizes high-quality leads for a product or service by understanding the business, researching target companies and decision-makers, and producing a ranked, actionable outreach list. Use this whenever someone asks to find leads, build a prospect list, identify target accounts, research companies for sales/BD/partnerships, or asks "who should I be reaching out to" — even if they don't use the word "leads" explicitly. If a paid data connector for prospecting (e.g. ZoomInfo, Apollo, Clay, LinkedIn Sales Navigator, a CRM) is available, prefer it over open web search for firmographic and contact accuracy.
---

# Lead Research Assistant

This skill identifies and qualifies potential leads for a business by understanding its product/service, defining an ideal customer profile (ICP), researching companies and decision-makers against that profile, and producing a ranked, ready-to-use outreach list.

## When to Use This Skill

- Finding potential customers or clients for a product/service
- Building a list of companies for partnership outreach
- Identifying target accounts for sales outreach
- Researching companies that match an ideal customer profile
- Preparing for business development activities

## Before You Start: Check for Better Data Sources

Generic web search can find companies, but purpose-built prospecting and CRM data is almost always more accurate and current — it has verified contact details, firmographic filters, technographic signals, and intent data that web search can't reliably produce. Before researching by hand:

1. Search the connector registry for prospecting/CRM tools (e.g. `ZoomInfo`, `Apollo`, `Clay`, `HubSpot`, `Salesforce`, `LinkedIn Sales Navigator`) and check installed skills — some environments ship dedicated lead-scoring and list-building skills (for example account research, build-list, or lead-scoring skills) that already do structured firmographic/intent filtering. Prefer those over ad hoc web search when they're available.
2. If a suitable connector or skill exists, suggest it to the user and lean on it for company/contact data, using this skill mainly for the ICP framing, scoring rubric, and outreach strategy layered on top.
3. If nothing is connected, fall back to web search and public sources (company sites, job postings, funding news, GitHub, LinkedIn) as described below — just be upfront that contact details found this way should be verified before sending anything.

## How to Use

### Basic Usage

Simply describe the product/service and what to look for:

```
I'm building [product description]. Find me 10 companies in [location/industry]
that would be good leads for this.
```

### With a Codebase

Run from the product's source directory for automatic context:

```
Look at what I'm building in this repository and identify the top 10 companies
in [location/industry] that would benefit from this product.
```

### Advanced Usage

For more targeted research, more detail up front means fewer wasted searches:

```
My product: [description]
Ideal customer profile:
- Industry: [industry]
- Company size: [size range]
- Location: [location]
- Current pain points: [pain points]
- Technologies they use: [tech stack]

Find me 20 qualified leads with contact strategies for each.
```

If the request is missing key details a real search needs — industry, geography, company size, or what counts as "qualified" — ask a short clarifying question (or use a structured question tool if one is available) rather than guessing at scope. It's cheaper to ask once than to research the wrong ICP for 20 companies.

## Instructions

1. **Understand the Product/Service**
   - If in a code directory, read the code/README to infer what the product does
   - Ask clarifying questions about the value proposition if it isn't clear
   - Identify key features, benefits, and what problem it solves

2. **Define the Ideal Customer Profile**
   - Target industries and sectors
   - Company size ranges
   - Geographic preferences
   - Relevant pain points
   - Any technology or tooling requirements

3. **Research and Identify Leads**
   - Use whatever prospecting connector/skill is available (see above) first; fall back to web search
   - Look for signals of need: job postings, tech stack, recent news, funding, expansion, hiring
   - Identify companies with complementary products/services
   - Note budget indicators where visible (funding stage, headcount, existing spend on adjacent tools)

4. **Prioritize and Score**
   - Assign a fit score (1-10) per lead based on: alignment with ICP, signals of immediate need, budget availability, competitive landscape, and timing
   - Sort the final list by score, highest first

5. **Provide Actionable Output**

   For each lead, include:
   - **Company name** and website
   - **Why they're a good fit** — specific reasons grounded in their actual business, not generic ICP restatement
   - **Priority score** with a one-line explanation
   - **Decision maker** — role/title to target (e.g., "VP of Engineering")
   - **Contact strategy** — how to approach them
   - **Value proposition for them** — the specific benefit to this company, not a copy-pasted pitch
   - **Conversation starters** — specific, referenceable points
   - **LinkedIn URL** if available

6. **Deliver the Right Format**

   For a quick answer in conversation, keep it scannable — company name, score, and a one-line "why" is often enough; save the full write-up (contact strategy, conversation starters, etc.) for the delivered file rather than repeating everything in chat.

   For anything the user will act on beyond this conversation — more than a handful of leads, or anything they'll load into a CRM or work from over several days — build it as an actual file rather than a wall of chat text:
   - A **spreadsheet** (.xlsx/.csv) is usually the right format for a lead list, since it sorts, filters, and imports into a CRM directly.
   - Use the structure below as the write-up template regardless of the underlying file format:

   ```markdown
   # Lead Research Results

   ## Summary
   - Total leads found: [X]
   - High priority (8-10): [X]
   - Medium priority (5-7): [X]
   - Average fit score: [X]

   ---

   ## Lead 1: [Company Name]

   **Website**: [URL]
   **Priority Score**: [X/10]
   **Industry**: [Industry]
   **Size**: [Employee count/revenue range]

   **Why They're a Good Fit**:
   [2-3 specific reasons based on their business]

   **Target Decision Maker**: [Role/Title]
   **LinkedIn**: [URL if available]

   **Value Proposition for Them**:
   [Specific benefit for this company]

   **Outreach Strategy**:
   [Personalized approach - mention specific pain points, recent company news, or relevant context]

   **Conversation Starters**:
   - [Specific point 1]
   - [Specific point 2]

   ---

   [Repeat for each lead]
   ```

   Deliver the finished file to the user rather than just describing it, so they have something to open, sort, and hand to a CRM or teammate. If this is a list the user is likely to keep updating (an ongoing pipeline, not a one-off list), consider offering to keep it as a living, revisitable document rather than a fresh file each time.

7. **Offer Next Steps**
   - Offer to draft personalized outreach messages for the top leads
   - Offer to save/export in CRM-import-ready format if not already done
   - Suggest deeper follow-up research on the highest-priority leads
   - If this is a recurring need (e.g. "find me leads every week"), offer to set up a recurring scheduled run instead of repeating the request manually

## Examples

### Example 1: Product-Led Lead Gen

**User**: "I'm building a tool that masks sensitive data in AI coding assistant queries. Find potential leads."

**Output**: A prioritized list of companies that:
- Use AI coding assistants (Copilot, Cursor, etc.)
- Handle sensitive data (fintech, healthcare, legal)
- Show evidence (public repos, job postings) of using coding agents
- Includes LinkedIn URLs of relevant decision-makers

### Example 2: Local Business

**User**: "I run a consulting practice for remote team productivity. Find me 10 companies in the Bay Area that recently went remote."

**Output**: Companies that:
- Recently posted remote job listings
- Announced remote-first policies
- Are hiring distributed teams
- Include personalized outreach strategies for each

## Tips for Best Results

- **Be specific** about the product and its unique value
- **Run from the codebase** if applicable, for automatic context
- **Provide ICP details up front** — industry, location, company size — to avoid a clarifying round-trip
- **Check for a real data connector first** — it beats web search on accuracy every time
- **Request follow-up research** on the most promising leads for deeper insight

## Related Use Cases

- Drafting personalized outreach emails after identifying leads
- Building a CRM-ready spreadsheet of qualified prospects
- Researching specific companies in detail
- Analyzing competitor customer bases
- Identifying partnership opportunities
