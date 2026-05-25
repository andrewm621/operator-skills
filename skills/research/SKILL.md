---
name: research
description: >
  Research a topic in the background using a subagent while you keep working. Returns a structured summary.
argument-hint: "<topic to research>"
---

Research a topic in the background using a subagent while you keep working. Returns a structured summary.

Topic: $ARGUMENTS

## Steps

1. **Classify the research type** — Based on `$ARGUMENTS`, determine the best approach:
   - **Codebase research** (e.g., "how does auth work in liberty-networking", "find all Stripe webhook handlers"): Use an Explore subagent scoped to the relevant project directory
   - **Documentation research** (e.g., "Drizzle ORM migration API", "Next.js 16 proxy.ts"): Use an Explore subagent to read local docs, or use Firecrawl/WebFetch to pull official docs
   - **Cross-project research** (e.g., "how do we handle cron jobs across projects"): Use an Explore subagent across ~/Projects
   - **External research** (e.g., "Stripe metered billing API", "Neon branching best practices"): Use web search and doc fetching tools

2. **Spawn the subagent** — Use the Agent tool with `subagent_type=Explore` (or a task agent for longer work). Give it a focused, specific prompt:
   - What exactly to find
   - Where to look
   - What format to return the findings in
   - Instruct it to be thorough but concise

3. **While the subagent works** — Tell the user the research is underway and what it's looking for. The user can continue giving you other instructions in the meantime.

4. **Deliver findings** — When the subagent returns, present a structured research summary:

   ```
   ## Research: <topic>

   ### Key Findings
   - Finding 1 with file references or doc links
   - Finding 2 with code examples if relevant
   - Finding 3

   ### Relevant Files
   | File | Why it matters |
   |------|---------------|
   | path/to/file.ts:42 | Contains the main implementation |
   | path/to/other.ts:15 | Related utility function |

   ### Code Examples
   (if applicable — short, focused snippets)

   ### Recommendations
   - What to do with this information
   - Gotchas or caveats discovered

   ### Sources
   - Files read, URLs fetched, docs consulted
   ```

5. **Offer follow-up** — Ask if the user wants to:
   - Dive deeper into a specific finding
   - Apply the findings to current work
   - Save as a dev-note or Notion page (`/document`)

## Notes
- This skill is designed for background research — tell the user they can keep working
- For simple, quick lookups (one file, one function), just use Grep/Read directly instead
- For cross-project searches, prefer `/search-all` if it's a simple pattern match
- This skill does NOT modify any files — it only reads and reports
- Multiple research tasks can run in parallel if they're independent
