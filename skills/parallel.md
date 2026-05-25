Run multiple tasks in parallel using subagents. Pipe-separated tasks are spawned simultaneously and results are aggregated.

Arguments: $ARGUMENTS

## Steps

1. **Parse tasks** — Extract individual tasks from `$ARGUMENTS`:

   **Pipe-separated format:**
   Split `$ARGUMENTS` on `|` (pipe character) and trim whitespace from each segment.
   Example: `research Stripe billing | check agencyos build | verify localhost:3000`
   → 3 tasks: ["research Stripe billing", "check agencyos build", "verify localhost:3000"]

   **Phase reference format:**
   If `$ARGUMENTS` starts with "phase", parse the phase number and optional task IDs.
   - `/parallel phase 2` → all pending tasks in Phase 2 of the active roadmap
   - `/parallel phase 2 tasks 2.3 2.4 2.5` → specific tasks from Phase 2
   - Read the active roadmap from `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/roadmaps/INDEX.md`, then parse the tasks from `roadmap.md`

   **Build-check format:**
   If `$ARGUMENTS` starts with "build-check", parse project names.
   - `/parallel build-check agencyos communityos liberty-networking`
   - This is a generalization of `/parallel-check` — each project gets a build agent

   If only 1 task is parsed, tell the user: "Only one task found — running directly instead of spawning an agent." Then just do the task.

2. **Classify each task** — Determine the best agent type and prompt for each:

   | Pattern in task description | Agent Type | Behavior |
   |---------------------------|-----------|----------|
   | starts with "research" or "find" or "explore" | Explore subagent | Read-only investigation, return findings |
   | starts with "check" or "build" or "test" | General agent with Bash | Run build/test commands, report pass/fail |
   | starts with "verify" or "check localhost" | General agent with Browser | Use agent-browser to verify a URL |
   | starts with "fix" or "update" or "edit" | General agent | Make code changes |
   | starts with "read" or "look at" | Explore subagent | Read files and summarize |
   | anything else | General agent | Interpret and execute the task |

   For each task, construct a specific agent prompt that includes:
   - The exact task to perform
   - The working directory (infer from project names mentioned, or use current dir)
   - Expected output format: a concise summary with pass/fail status
   - Any relevant context from the current conversation

3. **Display launch summary** — Before spawning, show what's about to happen:

   ```
    PARALLEL  Spawning 3 agents...

    [1] Research: Stripe metered billing API
        Type: Explore | Dir: ~/Projects

    [2] Build check: agencyos
        Type: Build | Dir: ~/Projects/agencyos

    [3] Verify: localhost:3000
        Type: Browser | Dir: current

    Running in parallel. You can continue working.
   ```

4. **Spawn all agents simultaneously** — Use the Agent tool to launch ALL tasks at once in a single message with multiple tool calls. This is critical for true parallelism.

   Each agent prompt should:
   - Be self-contained (don't reference other agents' work)
   - Include the full task description and context
   - Request a structured response: what was done, pass/fail, key details
   - Set appropriate working directory

5. **Aggregate results** — As agents complete, collect their results. Present a unified report:

   ```
    PARALLEL  3/3 completed

    [1] Research: Stripe metered billing         OK   45s
        Found 3 relevant endpoints. Usage records API supports
        metered billing with monthly invoicing. See @stripe/stripe-node.

    [2] Build check: agencyos                   FAIL  92s
        Type error in src/components/invoice.tsx:42
        Property 'amount' missing on type 'InvoiceProps'

    [3] Verify: localhost:3000                    OK   18s
        Page loads cleanly. 4 interactive elements found.
        No console errors.

    Summary: 2 passed, 1 failed
    Action needed: Fix agencyos build error
   ```

   **Report conventions:**
   - Results shown in original order (not completion order)
   - Status: OK, FAIL, WARN, SKIP
   - Duration shown in seconds
   - Key findings condensed to 1-3 lines per agent
   - Failed tasks get an "Action needed" callout

6. **Roadmap integration** — If tasks came from a phase reference:

   - For each agent that completed successfully (OK status):
     - Offer to mark the corresponding task as done in the roadmap
     - "Mark tasks 2.3, 2.4 as done? (2.5 failed)"
   - If the user confirms, update the roadmap file (same write pattern as `/todo done`)
   - Check for phase boundary completion

## Notes
- The key value of this skill is TRUE parallelism — all agents spawn at once. Never spawn them sequentially.
- Each agent is isolated — they don't share context or depend on each other's output. If tasks are dependent, tell the user: "Tasks X and Y depend on each other — running them sequentially instead."
- If an agent fails, the others continue. No fail-fast behavior.
- For build-check tasks, this skill generalizes `/parallel-check` to work with any projects, not just @rebel/ui consumers
- Agents run in the foreground by default so results are available immediately. For long-running tasks (builds), consider using `run_in_background: true` and telling the user to continue working.
- This skill pairs with the auto-parallel behavioral instruction in CLAUDE.md — this is the explicit version, the CLAUDE.md instruction is the implicit default.
- Maximum recommended parallel agents: 5. Beyond that, the aggregated results become hard to parse and system resources may be strained.
