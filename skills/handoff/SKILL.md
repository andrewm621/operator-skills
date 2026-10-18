---
name: handoff
description: >
  Hand a task off to Codex (or another agent) as a clean, well-scoped GitHub issue with acceptance criteria, file pointers, and constraints — the bridge between planning in one session and async execution elsewhere.
argument-hint: "<task to hand off>"
---

Hand a task off to Codex (or another agent) as a clean, well-scoped GitHub issue — the bridge between Claude Code planning and async execution elsewhere.

Task to hand off: $ARGUMENTS

**Config:** none — works from the current repo's GitHub remote.

This skill turns a loose task into a **Codex-ready GitHub issue**: scoped, with acceptance criteria, file pointers, and constraints, so an agent that *doesn't* have this conversation's context can still execute it correctly. The shared currency is git: this writes the **issue** (the inbox); the worker produces a **branch + PR** (the integration point you review). Role split in one line: Claude Code plans and reviews, Codex works async from issues and opens PRs, and you (or Cursor) are the human workbench in between.

## Steps

1. **Confirm the target repo.** Run `gh repo view --json nameWithOwner,defaultBranchRef -q '.nameWithOwner + " (" + .defaultBranchRef.name + ")"'` to confirm the current GitHub repo. If it fails (no remote / not a GitHub repo), stop and tell the user — offer to (a) `gh repo create`, or (b) write the task to a local `TASKS.md` handoff file instead. Never invent a repo.

2. **Understand the task.** From `$ARGUMENTS`, find the true intent — not just the surface ask. If two readings are both plausible, ask the user one clarifying question before drafting. A wrong handoff wastes a whole async Codex run.

3. **Gather context the worker won't have.** A cold agent rediscovers what we already know — front-load it:
   - Read the project's `CLAUDE.md` / `AGENTS.md` / `README` for conventions, stack, package manager, test/build commands.
   - Identify the **specific files/dirs** the task touches (`grep`/`glob` if needed) and list them as pointers.
   - Note constraints: framework version gotchas, "don't touch X", tokens/conventions to follow.

4. **Scope it the way Codex works best.** Codex executes a *bounded* ticket and opens a PR. Make the issue:
   - **Atomic** — one coherent change, reviewable as one PR. If `$ARGUMENTS` is really 3 tasks, say so and offer to create 3 linked issues.
   - **Verifiable** — acceptance criteria a machine/reviewer can check, plus how to verify (`npm run build`, `npm test`, the specific behavior to see).
   - **Self-contained** — file pointers + constraints inline, so no back-reference to this chat is needed.

5. **Draft the issue** with the template below (or the repo's own `.github/ISSUE_TEMPLATE/codex-task.md` if it has one). Fill every section; delete a section only if genuinely N/A. The title is `[task] <imperative summary>`.

   ````markdown
   ## Context
   <!-- Why this task exists. The 2-3 sentences of background the worker needs to
   make good decisions. Link related issues/PRs/docs. -->

   ## Task
   <!-- The single, atomic change to make. One coherent unit reviewable as one PR.
   If it's really several tasks, split into separate issues. -->

   ## Acceptance Criteria
   <!-- Checkable, unambiguous "done" conditions. -->
   - [ ]
   - [ ]

   ## File Pointers
   <!-- Where to look first. Exact paths beat prose. Saves the agent a discovery
   pass and keeps it from touching the wrong layer. -->
   - `path/to/relevant/file`
   - Conventions: see `CLAUDE.md` / `AGENTS.md` / `README`

   ## Constraints
   <!-- Guardrails: framework/version gotchas, "don't touch X", design tokens,
   patterns to follow, perf/security limits. -->
   -

   ## Out of Scope
   <!-- Explicitly what NOT to do — the cheapest way to prevent scope creep in an
   autonomous run. -->
   -

   ## How to Verify
   <!-- The exact commands / behavior that prove it works. -->
   ```bash
   # e.g. npm run build && npm test
   ```
   ````

   Replace the HTML comments with real content in the issue you create; they are guidance for you, not text to ship.

6. **Show the full drafted issue and STOP for approval.** Creating a GitHub issue is an outward-facing action — never create it silently. Present the title + body and ask: "Create this issue on `<repo>`? (I'll add label `codex` and return the number.)"

7. **On approval, create it:**
   ```bash
   gh issue create --repo <nameWithOwner> --title "<title>" --body "<body>" --label codex
   ```
   - If the `codex` label doesn't exist yet, create it first: `gh label create codex --color 6f42c1 --description "Scoped for autonomous agent pickup" 2>/dev/null || true`.
   - If the user named a different agent/label (e.g. `--cursor`), adjust the label accordingly.

8. **Return the handoff.** Report the issue number + URL and the literal next move:
   ```
   HANDOFF → <repo>#<N>
   <issue title>
   URL: <url>

   Next: open Codex on this repo and tell it: "Pick up issue #<N> and open a PR."
   When the PR lands, run /pr-review or ask me to review it before you merge.
   ```

## Notes
- **Claude Code stays the planner and the reviewer.** This skill only *emits* work; it doesn't execute it. The point of the role split is that the others run while you plan and review — review every PR (yourself or via `/pr-review`) before merge. That's the quality gate that keeps several tools from causing merge chaos.
- **Batch handoffs:** if the user passes several tasks (or says "open issues for the plan"), create one atomic issue per task and return all numbers. Offer to add them to a tracking issue or milestone if there are 3+.
- **Not everything should be handed off.** Coupled work that needs this conversation's full context is better kept here (subagents). Hand off the *independent, bounded* pieces — that's where async Codex pays off.
- **No GitHub remote?** Fall back to appending a structured task block (same template) to a local `TASKS.md` so the handoff isn't lost — then the user can `gh repo create` later and migrate it.
- Respect autonomy boundaries: drafting is autonomous; the `gh issue create` (external publish) needs explicit approval each run (step 6).
- `/maestro route T-<id> codex` calls this skill to create the issue for a Maestro task; the `handoff` verb inside `/maestro` is a different thing (a comms message).
