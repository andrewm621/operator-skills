Update the daily work log — a living document that tracks progress, decisions, and context throughout the day. Creates a new log if none exists for today, or appends to the existing one. `/log wrap` finalizes the day (and replaces the old one-shot session note).

Arguments: $ARGUMENTS (optional: entry text, "view", "wrap" to finalize, or a direction like "focus on auth decisions")

**Config:** `paths.notes` from `~/.config/operator-skills/config.yaml` (default `~/.claude/dev-notes`) — see `docs/config.md`. `<notes>` below is that directory; a missing file or key means the default.

## Steps

1. **Parse the intent** — Determine what the user wants from `$ARGUMENTS`:

   | Input | Action |
   |-------|--------|
   | (empty) | Auto-generate an entry from recent conversation context |
   | `view` | Display today's log (read-only) |
   | `wrap` or `wrap up` | Finalize today's log, extract learnings/decisions, update INDEX. Works even if you never logged during the day (it reconstructs from git and the conversation) |
   | `wrap <topic>` | Same, and also save a standalone session note named after the topic |
   | `wrap ... notion` | Same, and also create a Notion page with the summary (via `/notion`) |
   | `"some text"` | Add a directed entry with the provided text/focus |
   | A direction like "focus on the auth refactor" | Generate an entry scoped to that topic |

2. **Find or create today's log** — Check for an existing daily log:

   - Look for: `<notes>/sessions/YYYY-MM-DD-daily.md`
   - If it exists, read it — we'll append to it
   - If it doesn't exist, create it with the initial structure:

     ```markdown
     # Daily Log: YYYY-MM-DD

     Projects: <infer from conversation or current directory>

     ---

     ## Entries

     ```

3. **Generate the log entry** — Based on the action:

   **For auto-generated entries (empty `$ARGUMENTS`):**
   - Analyze the recent conversation since the last log entry (or session start)
   - Summarize what was accomplished, decisions made, problems hit
   - Note any files changed, features completed, or blockers encountered
   - Reference active roadmap progress if applicable

   **For directed entries (`$ARGUMENTS` has text or a focus area):**
   - Scope the entry to the specified topic
   - Pull relevant context from the conversation about that topic
   - Include specific details: code patterns chosen, trade-offs weighed, links to files

   **For `view`:**
   - Read and display today's log. If none exists, say so.
   - Stop here — no writes.

   **For `wrap`:**
   - Jump to Step 5 (finalization).

4. **Append the entry** — Add a timestamped entry to today's log:

   ```markdown
   ### HH:MM — <Brief Title>

   **What:** One-line summary of what happened.

   - Detail 1: specific thing accomplished or decided
   - Detail 2: specific thing accomplished or decided
   - Files: `path/to/file.ts`, `path/to/other.ts` (if relevant)
   - Decision: chose X over Y because Z (if applicable)
   - Blocker: description (if hit one)
   - Next: what comes after this (if clear)
   ```

   **Entry conventions:**
   - Timestamp is HH:MM in 24h format (current time)
   - Title should be 3-7 words, concrete ("Added Stripe webhook handler", not "Worked on stuff")
   - Keep entries concise — 3-6 bullet points max
   - Reference file paths when specific files were changed
   - Reference roadmap task IDs if applicable (e.g., "Completes task 2.3")
   - If a decision was made, capture the rationale briefly — this feeds into `<notes>/decisions/` later

5. **Wrap-up (when `$ARGUMENTS` starts with "wrap")** — Finalize the daily log:

   **a) Backfill if the day was under-logged.** If today's log doesn't exist or has fewer than 2 entries, reconstruct what happened before summarizing, rather than writing a thin summary:
   - Run in parallel: `git diff --stat HEAD~10..HEAD` (adjust the range to the session), `git log --oneline --since="today"`, and `git status --short` (uncommitted work)
   - Review the conversation for what was asked, key decisions and why, problems hit and how they were solved, and what's left
   - Build the list of key files created, modified, or deleted from the diff and the conversation
   - Write these as timestamped entries (step 4 format), marked as reconstructed, then continue. If several projects were touched, group by project.

   **b) Add a summary section** at the bottom of the log:
   ```markdown
   ---

   ## Daily Summary

   **Projects touched:** project1, project2
   **Total entries:** N
   **Key accomplishments:**
   - Accomplishment 1
   - Accomplishment 2

   **Decisions made:**
   - Decision 1 (consider extracting to <notes>/decisions/)

   **Problems & solutions:**
   - Problem encountered → how it was resolved

   **Files changed:**
   | File | Change | Notes |
   |------|--------|-------|
   | path/to/file.ts | Created | New component for X |

   **Open items:**
   - [ ] Thing that still needs doing
   - [ ] Question that needs answering

   **Learnings:**
   - Learning 1 (consider extracting to <notes>/learnings/)
   ```

   **c) Extract structured notes** — Check if the day's log contains:
   - A significant **decision** → offer to create `<notes>/decisions/YYYY-MM-DD-<topic>.md`
   - A non-obvious **learning** → offer to hand it to `/learn` (it owns the learnings format and index) rather than writing a learnings file here
   - **Memory-worthy patterns** → offer to update auto-memory files (only if `paths.memory` is set in the config; otherwise skip)

   **d) Update INDEX.md** — Append today's log to `<notes>/INDEX.md` (create it with a heading if missing) with a one-line summary.

   **e) Standalone session note (only if a topic was given)** — For `wrap <topic>`, also write `<notes>/sessions/YYYY-MM-DD-<topic>.md` using a short descriptive slug (e.g. "auth-refactor") with: Date, Project(s), What Was Done, Key Decisions, Problems & Solutions, Files Changed, What's Next (as `- [ ]` items). Add it to INDEX.md too. Skip this when no topic was given; the daily log already holds the same information.

   **f) Notion (only if `notion` was passed)** — Create a Notion page with the same summary by running `/notion note` with the wrap-up content, and link it back in the log.

   **g) Roadmap sync** — If there's an active roadmap, check if any tasks were completed during the day and offer to update them via `/todo done`.

6. **Confirm to user** — After appending an entry, show a brief confirmation:
   ```
    LOG  HH:MM — <Title>
    Added to daily log (entry #N today)
    View full log: /log view
   ```

## Notes
- `/log` is designed to be called MULTIPLE TIMES throughout the day. Each call appends a new timestamped entry.
- The daily log file uses the naming convention `YYYY-MM-DD-daily.md` to distinguish it from standalone session notes (`wrap <topic>`), which use `YYYY-MM-DD-<topic>.md`.
- Call `/log` after completing a feature, making a key decision, hitting a blocker, or switching projects. The more entries, the better the wrap-up summary.
- `/log wrap` at the end of the day produces a polished summary and extracts learnings/decisions. It works best from incremental entries, but it also covers the "I forgot to log" and "short one-off session" cases by reconstructing from git and the conversation (step 5a).
- If you forget to log during the day, `/log` with no arguments will reconstruct recent activity from conversation context — but real-time entries are always more accurate.
- The daily log is append-only during the day. Only `/log wrap` adds the summary section.
- This skill complements the roadmap pipeline: as you work through `/todo` tasks, `/log` captures the narrative of HOW you did them — context that task checkboxes don't preserve.
- Related: `/learn` for a single gotcha worth keeping, `/document` for docs, `/freeze` for resuming in a new thread.
