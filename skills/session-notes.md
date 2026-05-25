Write up a structured session note capturing what was done, decisions made, and what's next. Saves to dev-notes.

Arguments: $ARGUMENTS (optional: topic override or "notion" to also create a Notion page)

## Steps

1. **Check for daily log** — Before reconstructing from scratch, check if `/log` was used today:
   - Look for `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/sessions/YYYY-MM-DD-daily.md` (today's date)
   - If it exists AND has 2+ entries, suggest: "You have a daily log with N entries. Run `/log wrap` instead — it produces a richer summary from your incremental entries."
   - If the user still wants a session note (or no daily log exists), continue below.

2. **Gather session context** — Collect information about what happened this session:

   **a) Git changes** — Run in parallel:
   - `git diff --stat HEAD~10..HEAD` — files changed recently (adjust range based on session)
   - `git log --oneline --since="today"` or recent commits — what was committed
   - `git status --short` — any uncommitted work

   **b) Conversation review** — Analyze the current conversation for:
   - What the user asked to do
   - Key decisions made and why
   - Problems encountered and how they were solved
   - Tools/patterns/approaches used
   - What's left to do or follow up on

   **c) Files touched** — From git diff and conversation context, build a list of key files that were created, modified, or deleted.

3. **Determine the topic** — If `$ARGUMENTS` provides a topic, use it. Otherwise, infer from the session:
   - What was the main task or feature?
   - Use a short, descriptive slug (e.g., "claude-code-skills", "event-capacity", "auth-refactor")

4. **Write the session note** — Create a structured markdown file:

   ```markdown
   # Session: <Topic>
   Date: YYYY-MM-DD
   Project(s): <which projects were worked on>

   ## What Was Done
   - Bullet point summary of completed work
   - Each item specific and concrete

   ## Key Decisions
   - Decision 1: what was chosen and why
   - Decision 2: what was chosen and why

   ## Problems & Solutions
   - Problem encountered → how it was resolved

   ## Files Changed
   | File | Change | Notes |
   |------|--------|-------|
   | path/to/file.ts | Created | New component for X |
   | path/to/other.ts | Modified | Added Y method |

   ## What's Next
   - [ ] Follow-up task 1
   - [ ] Follow-up task 2
   - [ ] Open question that needs resolution
   ```

5. **Save the note** — Write to `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/sessions/YYYY-MM-DD-<topic>.md`

6. **Update the index** — Read `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/INDEX.md` and append the new entry with date, topic, and one-line summary.

7. **Optionally create Notion page** — If `$ARGUMENTS` includes "notion":
   - Create a Notion page with the same content using the Notion MCP tools
   - Link it back in the session note

8. **Check for learnings or decisions to extract** — If the session included:
   - A non-obvious technical learning → suggest saving to `dev-notes/learnings/`
   - An architecture decision → suggest saving to `dev-notes/decisions/`
   - A memory-worthy pattern → suggest updating auto-memory

## Notes
- **Use `/log wrap` instead if you've been logging throughout the day** — it produces a richer summary from incremental entries. This skill is for when you forgot to log or only had a short session.
- The conversation review step works by analyzing what was discussed — it has full context
- If multiple projects were touched, organize by project in the "What Was Done" section
- Session notes are append-only historical records — they supplement memory (what's true now) with context (what happened and why)
