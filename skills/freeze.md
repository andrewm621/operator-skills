Preserve full conversation context for cross-thread resumption. Dumps everything Claude currently knows into a machine-loadable file that a future Claude instance can ingest to pick up exactly where you left off.

Arguments: $ARGUMENTS (optional: topic slug, "list", "thaw", "thaw <slug>", or "all")

## Instructions

Parse `$ARGUMENTS` to determine the action:

| Input | Action |
|-------|--------|
| _(empty)_ | **Save** — auto-generate freeze from current context |
| `list` | **List** — show recent freezes (last 10) |
| `thaw` | **Thaw** — list recent freezes, ask user to pick one, then load it |
| `thaw <slug>` | **Thaw** — load a specific freeze file and resume |
| `all` | **Shutdown** — generate per-thread freeze commands for all active work |
| `"some text"` | **Save** — use as the topic slug |

---

## Save Flow

### 1. Detect compaction

Check if the current conversation contains the compaction marker:
> "This session is being continued from a previous conversation that ran out of context."

If found, extract the **full compaction summary verbatim** — everything between that marker and where the post-compaction conversation begins. This is the single most valuable piece of data in a freeze.

### 2. Gather environment state

Run these in parallel via Bash:

```bash
# Git state
git status --short
git branch --show-current
git log --oneline -5
git stash list

# Running dev servers
lsof -ti :3000,3001,3002,3003,3004,3005 2>/dev/null | head -20

# Today's daily log
ls -la ~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/sessions/$(date +%Y-%m-%d)*.md 2>/dev/null

# Active roadmap
ls ~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/roadmaps/*/roadmap.md 2>/dev/null | head -5
```

### 3. Analyze conversation context

Extract from the current conversation (or post-compaction portion if compacted):

- **Active task** — The single most important thing to resume. Be specific: "Implementing the /freeze skill" not "working on skills".
- **Progress** — What's completed, what's in-progress, what's blocked
- **Key decisions** — Decisions made with rationale (only non-obvious ones)
- **Files in play** — Every file read, created, or modified with its role in the current task
- **Code context** — Critical snippets or error messages the next session needs (cap: 3-5 snippets, <50 lines each). Include file paths and line numbers.
- **Open threads** — Unanswered questions, mentioned-but-not-acted-on items, things the user said they'd come back to

### 4. Determine slug

If `$ARGUMENTS` is non-empty and isn't a subcommand, use it as the slug.
Otherwise, generate a short descriptive slug from the active task (e.g., `freeze-skill-implementation`, `agencyos-auth-refactor`).

### 5. Compose freeze file

Use this exact template:

```markdown
# Context Freeze: <Topic>
Frozen: YYYY-MM-DD HH:MM | Project(s): <list> | CWD: <path>
Branch: <branch> (<clean|dirty>) | Last commit: <hash> <message>

> To resume: start a new session and run `/freeze thaw <slug>`
> Or say: "Load context from ~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/freezes/<filename>"

---

## Compacted Context
<!-- Verbatim compaction summary if present, or "No compaction — full context available at freeze time." -->

---

## Active Task
<What was being worked on — the specific thing to resume. Be concrete.>

## Progress
- **Completed:** ...
- **In-progress:** ...
- **Blocked on:** ...

## Key Decisions
- <Decision>: <rationale>

## Files in Play
| File | Status | Role |
|------|--------|------|
| path/to/file | Modified/Created/Read/Needs work | What it does in this task |

## Code Context
<!-- Critical snippets, error messages, or patterns the next session needs -->
<!-- Max 3-5 blocks, <50 lines each. Include file:line references. -->

## Open Threads
- <Unanswered questions, deferred items, things to come back to>

---

## Environment State
- **Uncommitted changes:** <git status summary or "clean">
- **Running processes:** <ports or "none detected">
- **Git stashes:** <list or "none">
- **Active roadmap:** <slug + current phase, or "none">
- **Today's log entries:** <count or "no log today">

---

## Resumption Prompt
> Continue with: <the most logical next action, written as an instruction>
```

### 6. Save the file

Write to: `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/freezes/YYYY-MM-DD-HHmm-<slug>.md`

Create the `freezes/` directory if it doesn't exist (use Bash: `mkdir -p`).

### 7. Update INDEX.md

Read `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/INDEX.md`.

If there's no `## Freezes` section, add one after the last existing section (before any blank trailing lines):

```markdown
## Freezes

Context snapshots for cross-thread resumption. Machine-optimized for Claude ingestion.

| Date | Topic | Project(s) | File |
|------|-------|------------|------|
```

Append the new entry to the Freezes table.

### 8. Confirm

Print:
```
Frozen: <slug>
Saved to: <full path>

To resume in a new thread:
  /freeze thaw <slug>
```

---

## Thaw Flow

When `$ARGUMENTS` starts with `thaw`:

### 1. Find the freeze file

- If a slug is provided after `thaw`: glob for `*<slug>*.md` in the freezes directory
- If no slug: list the 5 most recent freezes and ask the user to pick one via `AskUserQuestion`

### 2. Read the freeze file

Read the full contents of the selected freeze file.

### 3. Check for drift

Compare current state against the freeze:
- Is the git branch different? → warn
- Are there new commits since the freeze? → show them
- Has the CWD changed? → note it

### 4. Surface related freezes

Check for other freezes from the same project or same day:
```bash
# Same project
grep -l "Project(s):.*<project>" ~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/freezes/*.md 2>/dev/null
# Same day
ls ~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/freezes/<YYYY-MM-DD>*.md 2>/dev/null
```

If related freezes exist, show them after the main context:
```
Related freezes (same project/day):
  - 2026-05-12 14:30  rebelsites-pipeline-hardening (also rebelsites)
  - 2026-05-12 16:00  rebelsites-suggestion-chips   (also rebelsites)
You may want to thaw these too for full context.
```

### 5. Present context

Don't just dump the file. Actively orient:

```
Picking up from: <topic>
Frozen: <timestamp> (<relative time ago>)
Branch: <branch> | <drift warnings if any>

Last you were: <active task summary>
Progress: <completed> done, <in-progress> in flight, <blocked> blocked

Next action: <resumption prompt>
```

### 7. Read key files

If the freeze lists files with status "In-progress" or "Needs work", proactively read them to rebuild context.

### 8. Ask to continue

Suggest the resumption prompt action and ask if the user wants to proceed with it or do something else.

---

## Shutdown Flow (all)

When `$ARGUMENTS` is `all`:

This is for end-of-day shutdown when you have multiple terminals open. Claude can only freeze its **own** thread, so this flow:

### 1. Freeze the current thread first

Run the normal Save flow (steps 1-8 above) for this thread's context.

### 2. Detect other active work

Scan for signals of other active threads:
- Check today's freezes already saved: `ls ~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/freezes/$(date +%Y-%m-%d)*.md`
- Check git status across likely active projects (look at today's session logs for project names):
  ```bash
  # Parse project names from today's session files
  grep -l "$(date +%Y-%m-%d)" ~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/sessions/$(date +%Y-%m-%d)*.md 2>/dev/null
  ```
- Check running dev servers on common ports to identify active projects

### 3. Generate per-thread commands

Print a shutdown checklist with copy-pasteable commands for each terminal:

```
Shutdown Freeze Checklist
=========================

This thread: frozen as <slug>

Other active projects today:
  1. rebelsites (session log exists, port 3000 running)
     -> In that terminal, run: /freeze rebelsites-<inferred-topic>
  2. strata-local (session log exists)
     -> In that terminal, run: /freeze strata-<inferred-topic>

Already frozen today:
  - 2026-05-12 14:30  agencyos-auth-refactor

All done? Your freezes will be waiting:
  /freeze list
```

Infer topic slugs from session log filenames when possible (e.g., `2026-05-12-generation-pipeline-hardening.md` -> `generation-pipeline-hardening`).

### 4. Multi-thread same-project hint

If multiple session logs exist for the same project today, note this:

```
Note: rebelsites has 2 session logs today — you may have multiple
threads on this project. Freeze each thread with a distinct slug:
  /freeze rebelsites-pipeline-hardening
  /freeze rebelsites-suggestion-chips
```

---

## List Flow

When `$ARGUMENTS` is `list`:

Glob for `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/freezes/*.md` and show the 10 most recent:

```
Recent freezes:
  1. 2026-05-12 14:30  agencyos-auth-refactor     (agencyos)
  2. 2026-05-12 09:15  freeze-skill-implementation (skills)
  3. 2026-05-11 16:45  liberty-cron-debugging      (liberty-networking)
  ...

Thaw one with: /freeze thaw <slug>
```

Parse the topic from the `# Context Freeze:` header line and project from the `Project(s):` line.

---

## Key Principles

- **Optimize for Claude, not humans.** The freeze file should let a future Claude instance rebuild full working context in one read. Structure > prose.
- **Preserve the compaction summary verbatim.** This is irreplaceable compressed context. Never paraphrase it.
- **Be specific in the active task.** "Implementing X" is better than "working on the project." Include what step you're on.
- **Cap code snippets.** 3-5 blocks, <50 lines each. Only include what's needed to resume — not full file contents.
- **The resumption prompt is the most important line.** It should be a clear, actionable instruction that a future Claude can execute immediately.
