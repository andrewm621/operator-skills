---
name: document
description: >
  Document a feature, decision, architecture, or workflow. Writes to dev-notes, Notion, or inline code docs.
argument-hint: "<subject> [notion|dev-note|inline|readme]"
---

Document a feature, decision, architecture, or workflow. Writes to dev-notes, Notion, or inline code docs.

Arguments: $ARGUMENTS (what to document + optional target: "notion", "dev-note", "inline", "readme")

## Steps

1. **Parse the request** — From `$ARGUMENTS`, determine:
   - **Subject:** What to document (feature, decision, architecture, API, component, workflow)
   - **Target:** Where to write it (defaults based on subject type):
     - `notion` → Create a Notion page
     - `dev-note` → Write to dev-notes directory (decision or learning)
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

   **Notion page:**
   ```
   Use Notion MCP tools to create a page with:
   - Clear title and icon
   - Structured sections with headers
   - Tables for comparisons, APIs, or schemas
   - Code blocks for examples
   - Callouts for important notes
   ```

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

   **Dev-note learning:**
   ```markdown
   # Learning: <Title>
   Date: YYYY-MM-DD
   Projects: <which projects>

   ## Discovery
   What was learned

   ## Details
   Technical specifics

   ## Impact
   How this affects our work
   ```

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
   - Notion: use `mcp__claude_ai_Notion__notion-create-pages`
   - Dev-notes: write to `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/<type>/YYYY-MM-DD-<topic>.md`
   - Inline: edit source files with the Edit tool
   - README: write to project's `README.md`

5. **Update indexes** — If writing a dev-note:
   - Update `dev-notes/INDEX.md` with the new entry
   - If it's a decision or learning that should be remembered across sessions, suggest updating auto-memory too

6. **Present the result** — Show what was written and where. For Notion pages, include the URL.

## Notes
- The user can say things like:
  - `/document the auth flow` → documents how auth works in the current project
  - `/document decision: why we chose Drizzle over Prisma` → writes a decision record
  - `/document this feature notion` → creates a Notion page about the current feature
  - `/document readme` → generates/updates the project README
- When documenting code, read the actual source first — never guess at implementations
- For Notion pages, use appropriate icons and structured formatting
- Keep documentation concise and useful — avoid boilerplate padding
