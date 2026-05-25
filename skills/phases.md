Display the current roadmap progress with visual phase indicators. Reads from /roadmap data or any roadmap file.

Arguments: $ARGUMENTS (optional: roadmap slug, "list", "update <phase> <status>", or "next")

## Steps

1. **Find the roadmap** — Determine which roadmap to display:

   - If `$ARGUMENTS` provides a slug (e.g., `agencyos-v2-launch`), look for `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/roadmaps/<slug>/roadmap.md`
   - If `$ARGUMENTS` is "list", read `roadmaps/INDEX.md` and display all roadmaps as a table, then stop
   - If `$ARGUMENTS` is empty:
     - Read `roadmaps/INDEX.md` and find roadmaps with `status: active`
     - If exactly one active roadmap, use it
     - If multiple active, list them and ask the user to pick
     - If none, tell the user: "No active roadmaps. Run `/roadmap <topic>` to create one."
   - If `$ARGUMENTS` starts with "update", parse the phase number and new status, then jump to Step 4

2. **Parse the roadmap** — Read the `roadmap.md` file and extract:

   **a) Frontmatter:** title, slug, project, status, current_phase, phases_total
   **b) Per-phase data:** For each `## Phase N:` section:
   - Phase name (from the header)
   - Status (from the `status:` line)
   - Task list: count `- [x]` (completed) vs `- [ ]` (pending) vs `- [~]` (skipped)
   - Extract each task's ID, description, priority, and effort
   - Dependencies and notes

3. **Render visual display** — Output a rich terminal-friendly view:

   ```
    ROADMAP  <Title>
    Project: <project> | Created: <date> | Status: <status>

    Phase 1: <Name>                         Phase 2: <Name>
    ======================================  ======================================
    [##########] 5/5 COMPLETED              [######----] 2/6 IN PROGRESS
     x 1.1 Task description     high  L     x 2.1 Task description     high  M
     x 1.2 Task description     high  M     x 2.2 Task description     high  M
     x 1.3 Task description     med   S     . 2.3 Task description     high  L  <--
     x 1.4 Task description     high  L     . 2.4 Task description     med   L
     x 1.5 Task description     high  M     . 2.5 Task description     med   M
                                             . 2.6 Task description     low   S

    Overall: [########----------] 7/18 tasks (39%)
    Current: Phase 2, Task 2.3 next
    Unknowns: 2 unresolved
   ```

   **Visual conventions:**
   - `x` = completed task, `.` = pending task, `~` = skipped task
   - `<--` marks the next task to work on (first uncompleted in current phase)
   - Progress bars: `#` filled, `-` empty (10-char width)
   - Phase status in CAPS: COMPLETED, IN PROGRESS, PENDING, BLOCKED
   - Priority shown as `high`/`med`/`low`, effort as `S`/`M`/`L`

   **Layout rules:**
   - If 4 or fewer phases: show side-by-side (2 per row)
   - If 5+ phases: show vertically (one per block)
   - Keep total width under 120 chars

4. **Handle updates** — If `$ARGUMENTS` starts with "update":

   Parse: `/phases update <phase-number> <new-status>`
   - Valid statuses: `completed`, `in-progress`, `pending`, `blocked`
   - Update the `status:` line in the corresponding `## Phase N:` section
   - If completing a phase:
     - Check if the next phase's dependencies are met
     - If so, set next phase to `in-progress` and update `current_phase` in frontmatter
     - Set `started: YYYY-MM-DD` on the new phase
   - If all phases are completed, set frontmatter `status: completed`
   - Update `updated:` date in frontmatter
   - Update `INDEX.md` with new phase progress
   - Re-render the display after updating

5. **Phase boundary detection** — After rendering, check:

   - If the current phase has all tasks `[x]` or `[~]` (none `[ ]` remaining):
     - Prompt: "Phase N is complete! Ready to move to Phase N+1: <Name>?"
     - If the user confirms, update `current_phase`, set new phase to `in-progress`, and re-render
   - If `$ARGUMENTS` is "next":
     - Show only the current phase's remaining tasks
     - Suggest: "Run `/todo` to manage these tasks"

## Notes
- This skill is primarily a reader/displayer — it only writes to roadmap.md when explicitly asked to update status
- The visual output aims to give an at-a-glance overview of where things stand
- Pairs naturally with `/todo` for task-level management and `/roadmap` for creating new roadmaps
- If the roadmap file has formatting issues, try to parse gracefully rather than failing
- The `<--` marker always points to the first uncompleted task in the current phase, prioritizing high-priority tasks
