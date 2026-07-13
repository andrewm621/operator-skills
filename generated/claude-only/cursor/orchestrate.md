# orchestrate

Orchestrate a goal end-to-end: decompose it, route each piece to the best specialist agent, run pieces in parallel or as a pipeline, gate quality, and report. The smart layer above `/parallel` and `/subagent`.

Goal: {the text you type after the command}

Where `/parallel` does flat fan-out and `/subagent` runs one background agent, `/orchestrate` decides the *shape* of the work, picks the *right specialist* per task, applies *isolation and structured output* automatically, and *graduates to the `Workflow` tool* when the work outgrows simple fan-out.

## Steps

1. **Understand & decompose** — From `{the text you type after the command}`, determine the true goal (not just the surface ask). Break it into the smallest set of tasks that each have one clear owner and one clear output. For each task note: (a) is it read-only or does it write files? (b) does it depend on another task's output? (c) roughly how long / how much context does it need?

   If two readings of the goal are both plausible, ask one clarifying question (AskUserQuestion) before spawning anything. A wrong fan-out wastes more than a question does.

2. **Decide the shape** — Pick the execution model from this table. This is the most important step — it's the signpost that keeps simple work simple and routes heavy work to the right primitive.

   | The work is… | Use | Why |
   |---|---|---|
   | One task, right-sized (1–10 files, clear scope) | `/subagent` (or a single `Agent` call) | No orchestration overhead needed |
   | 2–5 **independent** tasks, no handoff between them | `/orchestrate` flat fan-out (this skill) | True parallelism, clean rollup |
   | Multi-stage where stage N needs stage N-1's output (research → write → review) | `/orchestrate` pipeline (this skill) | Sequenced handoff, still parallel within a stage |
   | A loop until a condition (find-until-dry, accumulate-to-N), a conditional branch, >5–8 items to pipeline, or you need resume / a token budget / schema-validated fan-out at scale | **`Workflow` tool** | Deterministic control flow, concurrency cap, resume, budget — beyond what prose orchestration can hold |
   | Tasks depend on each other but can't be expressed as clean stages | Sequential `Agent` calls | Correctness over speed |

   **If the row says `Workflow`, stop and author a Workflow script instead** (see the Workflow tool). Note that the Workflow tool requires explicit opt-in — if the user hasn't opted in, briefly describe the workflow you'd run and ask. Do not silently downgrade a Workflow-grade job into a fragile flat fan-out.

3. **Route each task to a specialist** — Match the task to the richest-fit named agent, not a generic one. Named specialists carry their own system prompts and conventions — they beat `general-purpose` on quality.

   | Task is about… | `agentType` | Notes |
   |---|---|---|
   | Research, fact-check, comparison, market/tech scan | `researcher` | Returns cited findings; checks any existing notes first |
   | Drafting/editing/repurposing content, docs, copy | `writer` | Read-only — can't write files; have it return text and you (or a writer-capable agent) land it |
   | Writing/changing/debugging code | `coder` | Reads conventions first, verifies build/tests |
   | Auditing a diff/PR/change before merge | `reviewer` | Read-only; reports, doesn't fix |
   | Designing an implementation strategy before code | `planner` | Returns a plan, not code |
   | Broad read-only search across many files/dirs | `Explore` | Returns the conclusion, not file dumps. Specify breadth: "medium" or "very thorough" |
   | Anything with no clean specialist, or that mixes read + write + bash | `general-purpose` | Full tool access — the fallback |

   When in doubt between a specialist and `general-purpose`: if the specialist is read-only (`researcher`, `writer`, `reviewer`, `Explore`) and the task must *write files*, either use `general-purpose` or split it (specialist produces, general-purpose lands).

4. **Apply isolation & structured output automatically** — Don't make the user ask for these:
   - **Worktree isolation** (`isolation: "worktree"`) for any set of parallel agents that *write to the same repo*. Parallel writers without isolation race the git index and clobber each other's files. Read-only agents never need it.
   - **Schema'd returns** when you'll aggregate results programmatically. Give each agent a small JSON schema — e.g. `{status: "ok"|"fail"|"warn", summary, details, action_needed}` — so the rollup is reliable instead of prose-parsed. For a single narrative result, skip the schema.

5. **Mandate context pointers** — Every spawned prompt MUST tell the agent where to look first. A cold agent rediscovers what we already know. Include:
   - The working directory / repo, and "read `CLAUDE.md` (or the README) first if it exists"
   - The specific index/file/dir that bears on the task (a named source file, the relevant module, an architecture doc)
   - The goal and the exact output format expected — not the full conversation history

6. **Spawn** — Launch all independent tasks in a **single message with multiple `Agent` calls** for true parallelism. Default long or independent tasks to `run_in_background: true` so the user isn't blocked (you're notified on completion). For a pipeline, spawn stage 1, then spawn stage 2 with stage 1's output once it lands.

   Before spawning, show a one-line launch summary: "Running these N in parallel/as a pipeline: [list with agentType each]."

7. **Gate quality & retry** — When results come back, review before presenting. If a result is weak, wrong, or thin, re-delegate to the same agent with *specific* feedback (max 2 retries). Flag anything still uncertain or failed plainly. For write tasks, confirm the agent verified its work (build/type-check/tests) before accepting.

   Sequencing-sensitive tail steps (git commit/push, deploy) are NOT parallel work — do them yourself *after* the relevant agents finish, so the commit stays clean. Never fan out a git commit alongside the file edits it's meant to capture.

8. **Report** — Present a unified rollup in original task order, leading with the answer:

   ```
   ORCHESTRATE  N/N complete

   [1] researcher · Neon branching API scan     OK
       Synthesized 8 sources → recommended copy-on-write per PR preview.
   [2] coder · add webhook handler              OK
       New route + Zod schema + test. Build + types pass.
   [3] reviewer · audit the diff                OK (returned report; no blockers)

   Result: <the one thing that matters> · Open decisions: <if any>
   ```

## Notes
- This skill is orchestration made explicit. Reach for it whenever the work is substantive and multi-step; use `/parallel` for a quick flat fan-out you've already scoped, and `/subagent` for a single fire-and-forget change.
- The graduation rule (step 2) is the point of this skill: don't force loops, conditionals, large pipelines, or resume/budget needs through prose orchestration — that's what the `Workflow` tool exists for. And don't reach for `Workflow` on a 3-task fan-out — that's over-engineering.
- Specialist routing (step 3) is the quality lever. The named agents exist precisely so we stop spawning blank `general-purpose` agents for work that has a better-fit owner.
- Respect autonomy boundaries: research/read is autonomous; anything that sends, publishes, spends, deploys, or is hard to reverse needs the user's approval — even when a subagent could technically do it.
- Max ~5 agents per *visible* fan-out (rollup legibility, not a system limit). Need more concurrent units than that? That's a `Workflow` (its real cap is ~14 concurrent, 1000 lifetime).
- Hand every agent context pointers (step 5). This is non-negotiable and is the most common reason a delegation comes back shallow.
