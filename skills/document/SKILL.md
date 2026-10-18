---
name: document
description: >
  Document a feature, decision, architecture, or workflow. Writes decision records, inline code docs, or a README, and hands Notion pages to `/notion` and learnings to `/learn`.
argument-hint: "<subject> [notion|dev-note|inline|readme]"
---

Document a feature, decision, architecture, or workflow. Writes decision records, inline code docs, or a README, and hands Notion pages to `/notion` and learnings to `/learn`.

Arguments: $ARGUMENTS (what to document + optional target: "notion", "dev-note", "inline", "readme")

**Config:** `paths.notes` from `~/.config/operator-skills/config.yaml` (default `~/.claude/dev-notes`) — see `docs/config.md`. `<notes>` below is that directory; a missing file or key means the default.

## Steps

1. **Parse the request** — From `$ARGUMENTS`, determine:
   - **Subject:** What to document (feature, decision, architecture, API, component, workflow)
   - **Target:** Where to write it (defaults based on subject type):
     - `notion` → Create a Notion page (delegated to `/notion`)
     - `dev-note` → Write a decision record to `<notes>/decisions/`. If the subject is a **learning** (a gotcha, quirk, or mistake worth not repeating), delegate to `/learn` instead — see step 4
     - `inline` → Add JSDoc/comments to source files
     - `readme` → Update or create project README
     - If no target specified: use best default for the subject type

2. **Gather information** — Based on the subject, collect context:

   **For a feature/component:**
   - Read the relevant source files
   - Identify the public API (exports, props, params)
   - Understand how it connects to other parts of the system
   - Note any configuration or environment variables required
   - Check for existing tests that document behavior

   **For a decision:**
   - What was the context (problem being solved)?
   - What was chosen and why?
   - What alternatives were considered?
   - What are the tradeoffs?
   - Which projects are affected?

   **For architecture:**
   - What are the key components and how do they connect?
   - What's the data flow?
   - What are the boundaries and interfaces?
   - What patterns are used and why?

   **For a workflow/process:**
   - What are the steps?
   - What tools are involved?
   - What are the prerequisites?
   - What are the common failure modes?

3. **Draft the document** — Write it in the appropriate format:

   **Notion page:** draft the content as Markdown with a clear title, structured sections with headers, tables for comparisons, APIs, or schemas, code blocks for examples, and callouts for important notes. `/notion` writes it (step 4).

   **Dev-note decision:**
   ```markdown
   # Decision: <Title>
   Date: YYYY-MM-DD | Status: Implemented
   Projects: <which projects>

   ## Context
   Why this decision was needed

   ## Decision
   What was chosen

   ## Alternatives
   What was considered and rejected

   ## Consequences
   What this means going forward
   ```

   **Learning:** don't draft a separate template here. `/learn` owns the learnings format (title, category, tags, problem, solution, why it's non-obvious) and its searchable index; step 4 hands the subject to it.

   **Inline docs:**
   - JSDoc comments for functions and components
   - Type annotations where missing
   - Brief module-level comments for files without context
   - Keep it minimal — only add where the code isn't self-explanatory

   **README:**
   - Project overview and purpose
   - Setup instructions
   - Key scripts and commands
   - Architecture overview
   - Environment variables required

4. **Write the document** — Save to the appropriate location:
   - Notion: run `/notion` with the drafted content (`/notion note "<title>"` for a dev note, `/notion decision "<title>"` for a decision, `/notion update <topic>` to revise an existing page) instead of calling the Notion tools directly. It resolves the project from the registry and picks the right tool
   - Learning: run `/learn "<the learning>"` and let it extract, categorize, save, and index it; don't write a learnings file from this skill
   - Decision record: write to `<notes>/decisions/YYYY-MM-DD-<topic>.md` (create the directory if needed)
   - Inline: edit source files with the Edit tool
   - README: write to project's `README.md`

5. **Update indexes** — If writing a decision record:
   - Update `<notes>/INDEX.md` with the new entry (create it with a heading if missing)
   - If it should be remembered across sessions, suggest updating auto-memory too (only if `paths.memory` is set in the config; otherwise skip)
   - (`/learn` maintains its own index for learnings.)

6. **Present the result** — Show what was written and where. For Notion pages, include the URL `/notion` returns.

## Notes
- The user can say things like:
  - `/document the auth flow` → documents how auth works in the current project
  - `/document decision: why we chose Drizzle over Prisma` → writes a decision record
  - `/document this feature notion` → creates a Notion page about the current feature
  - `/document readme` → generates/updates the project README
- When documenting code, read the actual source first — never guess at implementations
- For Notion pages, use structured formatting; `/notion` handles icons and properties
- Keep documentation concise and useful — avoid boilerplate padding
