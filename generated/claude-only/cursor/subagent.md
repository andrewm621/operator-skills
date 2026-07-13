# subagent

Dispatch a task to a background agent that explores the codebase, plans the implementation, and makes the changes — all while you keep working in the primary session.

Task: {the text you type after the command}

## Steps

1. **Parse the task** — From `{the text you type after the command}`, determine:

   **a) Scope:** What needs to be done? Could be:
   - A feature to implement ("add email notifications to liberty-networking")
   - A bug to fix ("fix the timezone issue in the cron jobs")
   - A refactor ("convert the auth middleware to use proxy.ts")
   - A setup/config task ("add Stripe webhook handler to agencyos")

   **b) Target project:** Infer the project directory from the task description:
   - If a project name is mentioned, map it to `~/Projects/<dir>`
   - If already cd'd into a project, use the current directory
   - If ambiguous, the agent should check the codebase to determine the right location

   **c) Complexity check:** Before spawning, quickly assess if this task is:
   - **Too simple** for a subagent (single-line change, renaming) → just do it directly, skip the agent
   - **Too large** for a single agent (multi-project refactor, 20+ files) → suggest breaking it up or using `/parallel`
   - **Right-sized** (1-10 files, clear scope) → proceed with spawning

2. **Construct the agent prompt** — Build a detailed, self-contained prompt for the background agent. The prompt MUST include:

   **Context:**
   - The working directory to operate in
   - Any relevant context from the current conversation (what was discussed, decisions made)
   - The project's stack if known (check memory files or CLAUDE.md)

   **Instructions:**
   - "Read the project's CLAUDE.md first if it exists"
   - "Explore the relevant code to understand the current implementation before making changes"
   - "If something is unclear or there are multiple valid approaches, use AskUserQuestion to clarify before proceeding"
   - The specific task to accomplish
   - Any constraints or preferences mentioned by the user

   **Quality expectations:**
   - "Follow existing patterns and conventions in the codebase"
   - "Don't over-engineer — make the minimum changes needed"
   - "Run type-check (npx tsc --noEmit) or build after making changes to verify they compile"
   - "If tests exist for the area you're changing, run them"

   **Reporting:**
   - "When done, provide a summary of: what you changed, files modified, any decisions you made, and anything that needs follow-up"

3. **Spawn the agent in the background** — Use the Agent tool with:
   - `subagent_type`: Use `general-purpose` (it needs read + write + bash access)
   - `run_in_background: true` — this is critical so the user can keep working
   - A clear, descriptive `description` (3-5 words)

4. **Confirm to the user** — After spawning, briefly tell the user:

   ```
    SUBAGENT  Dispatched: <task summary>
    Working in: ~/Projects/<project>
    Agent will: explore → plan → implement → verify
    You'll be notified when it completes. Keep working.
   ```

   Then STOP and let the user continue with whatever they're doing. Do NOT wait for the agent or poll for results.

5. **When the agent completes** — You'll be automatically notified. Present the results:

   ```
    SUBAGENT COMPLETE  <task summary>         <duration>

    ## What Was Done
    - Change 1: description
    - Change 2: description

    ## Files Modified
    | File | Change |
    |------|--------|
    | path/to/file.ts | Added/Modified/Created — brief description |

    ## Decisions Made
    - Chose X over Y because Z (if applicable)

    ## Verification
    - Type check: PASS/FAIL
    - Tests: PASS/FAIL/SKIPPED (no tests found)

    ## Follow-up Needed
    - [ ] Anything that still needs attention
   ```

   If the agent used AskUserQuestion during execution, those interactions happened inline. The summary should note what was clarified.

6. **Roadmap integration** — If there's an active roadmap and the task corresponds to a roadmap task:
   - Mention which task ID it maps to (e.g., "This completes task 2.3")
   - Offer to mark it done: "Run `/todo done 2.3` to update the roadmap"

## Notes
- This is the "fire and forget" implementation skill. Use `/research` for read-only investigation, `/subagent` for making actual changes.
- The agent runs in the BACKGROUND — you will be notified when it completes. Do NOT poll, sleep, or check on it. Continue working with the user.
- The agent CAN use AskUserQuestion if it encounters ambiguity. This surfaces a question to the user even while you're in the middle of other work.
- For truly independent tasks, you can dispatch multiple `/subagent` calls. Each runs in its own background agent.
- The agent should ALWAYS verify its work (type-check, build, or tests) before reporting completion.
- If the task requires changes across multiple projects, suggest `/parallel` instead — each project gets its own agent.
- The agent has full tool access (Read, Edit, Write, Bash, Glob, Grep) — it can explore and implement.
- Do NOT dispatch a subagent for trivial tasks that would take you 30 seconds to do directly. Use judgment.
