Manage tasks within the current roadmap phase or as a standalone list. Add, complete, skip, reprioritize, and view tasks.

Arguments: $ARGUMENTS

## Steps

1. **Parse the subcommand** — Determine what action to take from `$ARGUMENTS`:

   | Input | Action |
   |-------|--------|
   | (empty) | Show current phase tasks |
   | `add <description>` | Add a task to current phase or standalone list |
   | `done <id>` or `complete <id>` | Mark task as completed (e.g., `done 2.3`) |
   | `skip <id>` | Mark task as skipped with reason |
   | `pri <id> <level>` | Change priority (high, medium, low) |
   | `move <id> after <id>` | Reorder a task within its phase |
   | `standalone <name>` | Create or show a freestanding todo list |
   | `unknowns` | Show unresolved risks from the roadmap |
   | `summary` | Quick stats: done/total, effort remaining |

2. **Find the data source** — Determine where to read/write tasks:

   **For roadmap-connected tasks:**
   - Read `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/roadmaps/INDEX.md`
   - Find the active roadmap (status: active)
   - If exactly one, use it. If multiple, ask the user to pick. If none, fall through to standalone.
   - Read the roadmap's `roadmap.md` and locate the current phase (from `current_phase` in frontmatter)

   **For standalone tasks:**
   - If `$ARGUMENTS` starts with "standalone", use `roadmaps/standalone/` directory
   - If a name is provided (e.g., `standalone quick-tasks`), use `todo-YYYY-MM-DD-<name>.md`
   - If no name, use `todo-YYYY-MM-DD.md` (today's date)
   - If the file doesn't exist, create it with frontmatter:
     ```yaml
     ---
     title: "Quick Tasks — <Name or Date>"
     created: YYYY-MM-DD
     updated: YYYY-MM-DD
     type: standalone
     ---
     ```

3. **Execute the action:**

   **`show` (default — empty arguments):**
   - Display the current phase's tasks in a focused view:

     ```
      TODO  Phase 2: Core Features (2/6)
      Roadmap: agencyos-v2-launch

      x  2.1 Client dashboard layout         high  M   done
      x  2.2 Project list with status         high  M   done
      >  2.3 Invoice display + Stripe         high  L   next
         2.4 File upload with presigned URLs   med   L
         2.5 Activity feed component           med   M
         2.6 Client settings page              low   S

      Remaining: ~4 tasks | est. effort: L+L+M+S
      Run: /todo done 2.3 | /todo add "new task" | /todo skip 2.4
     ```

   - `x` = completed, `>` = suggested next (first uncompleted, highest priority), blank = pending, `~` = skipped
   - Show a quick effort estimate and helpful command hints at the bottom
   - For standalone lists, show the same format but without phase context

   **`add <description>`:**
   - Parse the description. Check for inline modifiers: `priority:high`, `effort:M`
   - Defaults: priority:medium, effort:M
   - If in a roadmap phase: auto-assign the next task ID (e.g., if last task is 2.6, new one is 2.7)
   - Append the new task line: `- [ ] <id> <description> | priority:<p> | effort:<e>`
   - Update the phase's `progress:` line (increment total)
   - If standalone: just append to the list (no phase ID prefix)
   - Show the updated task list

   **`done <id>` / `complete <id>`:**
   - Find the task line matching the ID (e.g., `2.3`) in the roadmap file
   - Change `- [ ]` to `- [x]`
   - Update the phase's `progress:` line (increment completed count)
   - Update `updated:` date in frontmatter
   - **Phase boundary check:** If this was the last `[ ]` task in the phase (ignoring `[~]` skipped):
     - Announce: "Phase N complete! All tasks done."
     - If there's a next phase, ask: "Ready to start Phase N+1: <Name>?"
     - If yes: update `current_phase` in frontmatter, set next phase `status: in-progress`, add `started: YYYY-MM-DD`
     - Update INDEX.md with new phase progress
   - Show the updated task list

   **`skip <id>`:**
   - Find the task line matching the ID
   - Change `- [ ] <id> <description>` to `- [~] ~~<id> <description>~~ | skipped`
   - Ask for a brief reason and append it: `| skipped: <reason>`
   - Check for phase boundary (same as `done` — skipped tasks don't block completion)
   - Show the updated task list

   **`pri <id> <level>`:**
   - Find the task line matching the ID
   - Replace `priority:<old>` with `priority:<new>`
   - Valid levels: high, medium, low (accept "med" as alias for "medium")
   - Show the updated task list

   **`move <id> after <target-id>`:**
   - Find both task lines in the file
   - Remove the source task line and insert it after the target task line
   - Re-number task IDs within the phase to maintain sequential order
   - Show the updated task list

   **`standalone <name>`:**
   - If the standalone file exists, read and display it (same format as `show`)
   - If it doesn't exist, create it and tell the user: "Created standalone list. Use `/todo add <task>` to add items."
   - When adding to a standalone list, tasks don't get phase-prefixed IDs — just simple checkboxes

   **`unknowns`:**
   - Read the `## Unknowns & Risks` section from the active roadmap
   - Display each unknown with its checkbox status
   - For unresolved ones (`[ ]`), offer: "Spawn `/research <unknown>` to investigate?"

   **`summary`:**
   - Parse all phases in the active roadmap
   - Display:
     ```
      SUMMARY  agencyos-v2-launch
      Phases: 1 completed, 1 in-progress, 2 pending
      Tasks: 7/18 done (39%)
      Effort remaining: ~3L + 2M + 1S
      Current: Phase 2, next task: 2.3 Invoice + Stripe
      Unknowns: 2 unresolved
      Days since created: 5
     ```

## Notes
- All writes go back to the same `roadmap.md` file that `/roadmap` created and `/phases` reads — they share the same data
- For standalone lists, writes go to `roadmaps/standalone/todo-*.md`
- The `>` marker in the display always points to the first uncompleted task, preferring higher-priority tasks (high > medium > low)
- Phase boundary transitions update both the roadmap file and INDEX.md, keeping `/phases` in sync
- If no roadmap is active and the user runs `/todo` without "standalone", suggest: "No active roadmap. Run `/todo standalone <name>` for a quick list, or `/roadmap` to plan a project."
- Task IDs are stable — completing or skipping a task doesn't renumber others (only `/todo move` renumbers)
