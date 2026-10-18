Run multiple tasks in parallel using subagents. Pipe-separated tasks are spawned simultaneously and results are aggregated. `build-check` fans out build/type-check agents across the projects that depend on a shared package.

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
   If `$ARGUMENTS` starts with "build-check", resolve the list of projects to check, then give each one a build agent (see "Build-check flow" below).
   - `/parallel build-check agencyos communityos web-app` — check exactly these projects
   - `/parallel build-check` or `/parallel build-check all` — auto-detect every consumer of the shared package you are standing in
   - `/parallel build-check all --dep @acme/ui` — auto-detect consumers of a named package (use when the current directory isn't the package)

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

## Build-check flow

Use this when `$ARGUMENTS` starts with "build-check". It covers the "did my shared-package change break its consumers?" check.

1. **Resolve the consumers:**
   - **Named projects** — use exactly those; skip detection.
   - **`all` or empty** — detect them. First find the shared package: `--dep <name>` if given, otherwise the `name` field of the nearest `package.json` at or above the current directory.
   - **Find consumers by grepping `package.json` files for that dependency** — never from a hardcoded list. Search the sibling projects of the current one, plus workspace packages if this is a monorepo (`turbo.json`, `pnpm-workspace.yaml`, or `workspaces` in `package.json`):
     ```bash
     PKG="<package-name>"
     ROOT="$(dirname "$PWD")"        # the folder that holds sibling projects (use the repo root in a monorepo)
     find "$ROOT" -maxdepth 4 \( -name node_modules -o -name .next -o -name dist \) -prune \
       -o -name package.json -print0 | xargs -0 grep -lE "\"$PKG\"[[:space:]]*:"
     ```
     Count a project as a consumer only if the match is under `dependencies`, `devDependencies`, or `peerDependencies`, and exclude the package itself.
   - If nothing is found, say so and ask which projects to check. If the dependency can't be inferred (no `package.json` above the cwd), ask what changed.
2. **Make sure the shared package is built.** If it has a build output (`dist/`) and the sources are newer, run its build first (`pnpm build` / `npm run build`). Consumers that link to it (`link:`, `workspace:`, `file:`) would otherwise test stale output.
3. **Spawn one agent per consumer, all at once** (see step 4 above). Each one:
   - `cd`s into the project and installs if needed (`pnpm install` / `npm install`, matching its lockfile) to pick up the linked changes
   - Runs `npx tsc --noEmit` (type check), then the project's `build` script
   - Reports pass/fail with the first relevant error
4. **Report** with one row per consumer (Types, Build, Status), then list each failure with the exact error and an action item:
   ```
    PARALLEL  build-check: @acme/ui   (N consumers)

    | Project  | Types | Build | Status  |
    |----------|-------|-------|---------|
    | web-app  | PASS  | PASS  | OK      |
    | admin    | FAIL  | -     | Blocked |

    admin: src/components/nav.tsx:23 — Property 'variant' does not exist on type 'ButtonProps'
   ```
5. **Offer fixes** — for each failure, show the error and which change caused it, offer to fix it, and after fixing offer to re-run just that project.

This only builds and type-checks locally. It never commits or pushes.

## Notes
- The key value of this skill is TRUE parallelism — all agents spawn at once. Never spawn them sequentially.
- Each agent is isolated — they don't share context or depend on each other's output. If tasks are dependent, tell the user: "Tasks X and Y depend on each other — running them sequentially instead."
- If an agent fails, the others continue. No fail-fast behavior.
- `build-check` works for any shared package (a design system, an SDK, a monorepo library) — consumers are detected from `package.json`, not from a fixed list.
- Builds can take 30s-2min per project; parallel execution saves most of that.
- Agents run in the foreground by default so results are available immediately. For long-running tasks (builds), consider using `run_in_background: true` and telling the user to continue working.
- This skill pairs with the auto-parallel behavioral instruction in CLAUDE.md — this is the explicit version, the CLAUDE.md instruction is the implicit default.
- Maximum recommended parallel agents: 5. Beyond that, the aggregated results become hard to parse and system resources may be strained.
