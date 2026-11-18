# orchestrate

Orchestrate a goal end-to-end: decompose, route, verify, report. You are the orchestrator: you plan, delegate, check and ship. Agents do the building.

Goal: {the text you type after the command}

## Steps

1. **Decompose.** Find the true goal, not just the surface ask. Break it into the fewest tasks that each have one owner and one output. For each, note: read-only or writes files? Depends on another task? How much context does it need? If two readings of the goal are both plausible, ask one question before spawning anything.

2. **Decide the shape.**

   | The work is… | Use |
   |---|---|
   | One task | A single `Agent` call |
   | 2–7 **independent** tasks | Several `Agent` calls in **one message** (they run in parallel) |
   | Stages where N needs N-1's output, or tasks that depend on each other | Sequential `Agent` calls (a pipeline). Long pipelines stay this way; they work. |
   | A wide batch (~8+ similar items), or a multi-stage pipeline with verify/repair loops, resume or a budget | The `Workflow` tool, **only if the user has opted into workflows**. Otherwise describe the workflow you'd run and ask. |
   | A workstream that should outlive this conversation and land on its own branch/PR | A separate session (`start_session`, where the app offers it), with the model set |

   Never use `Workflow` for a 3-task fan-out.

3. **Route each task.** `subagent_type` picks the agent; `model` picks the brain. **Every `Agent` call passes `model`.**

   | Task | `subagent_type` | `model` |
   |---|---|---|
   | Write, change or debug code | `coder` → else `general-purpose` | `opus` |
   | Audit a diff/PR, or a rendered UI from screenshots | `reviewer` → else `general-purpose` | `opus` |
   | Plan an implementation before code | `planner` → else `Plan` | `opus` |
   | Research, fact-check, comparison | `researcher` → else `general-purpose` | `opus` |
   | Draft or edit prose (returns text; you land it) | `writer` → else `general-purpose` | `opus`, or `sonnet` for light edits |
   | Broad read-only search across many files | `Explore` | `sonnet` (or `opus` for deep reads) |
   | Lookups, inventories, formatting, test runs, simple edits | `general-purpose` | `sonnet` |
   | Needs the current conversation's context to make sense | `fork` | ignored (inherits yours) |

   - **Built-ins** always exist: `general-purpose`, `Explore` (read-only search), `Plan` (read-only planning), `fork`.
   - **Custom agents** (`coder`, `reviewer`, `planner`, `researcher`, `writer`) exist only if the user defined them. Use one when it's in this session's agent list; otherwise fall back to `general-purpose` (or `Explore`/`Plan`) with the **same brief**: same task, pointers and output format. Name the type you actually spawn in the launch line.
   - Read-only agents (`reviewer`, `researcher`, `writer`, `Explore`, `Plan`) can't write files. If the task must write, use `general-purpose`, or split it (specialist produces, `general-purpose` lands).
   - **Models:** default `opus` for building, research, planning and review; `sonnet` for light or mechanical work. An explicit `model` overrides the agent definition's frontmatter, and definitions often default to a cheaper model, so never omit it and never let a subagent silently inherit the session model. Use the top-tier (most expensive) model only when the user names it. Set `effort` only when the user asks for one.

4. **Isolation and structured output.**
   - **Worktrees** (`isolation: "worktree"`) for parallel agents writing to the same repo, but check `git status` first. If the real state lives in uncommitted WIP, worktrees branch from a commit that lacks it. Then run agents in the shared tree with **disjoint file sets**, type-check-only verification (no concurrent builds), told **not to touch git**, and run one build yourself afterwards.
   - **Schema'd returns** when you'll aggregate results: e.g. `{status: "ok"|"fail"|"warn", summary, details, action_needed}`. Skip it for a single narrative result.

5. **Brief every agent like a cold peer.** Include the repo/working directory and "read `CLAUDE.md` or the README first"; the specific files, docs or index that bear on the task; the goal, what's already ruled out, and the exact output format. Not the whole conversation. A thin brief is the top reason delegations come back shallow.

6. **Spawn.** Show one line first: `Running N in parallel / as a pipeline: [subagent_type · model · task] …`. Agents run in the background and you're notified when each hands back. Keep a visible fan-out to about 5–7.

7. **Gate quality.** Don't accept "verified, no issues" at face value.
   - **Independent review:** for code, a review agent that didn't write it reads the diff.
   - **Re-run it yourself:** the main session re-runs build, type-check and tests before accepting any write task.
   - **Look at it yourself:** for anything rendered (UI, design, report, motion), take the screenshots or frames and look personally. Check the final/resting state, where stuck-state bugs hide. Agents check mechanics, not meaning. For a second opinion, give a review agent the screenshots.
   - **Fix loop:** send specific feedback to the **same agent with `SendMessage`** (it keeps its context). Up to 2 rounds, then flag it.

## Session mode

`/orchestrate` usually runs a whole session, not one shot. Re-typing it means "keep delegating". The loop:

1. Take the next task from the plan or roadmap.
2. Spawn **one agent** for it (step 3 routing, explicit model).
3. Main session re-runs build/tests and looks at the output.
4. Problems → `SendMessage` the same agent with exact fixes. Don't spawn fresh, and don't fix it inline.
5. Commit that task (main session), then go to 1.

**The main session owns** decomposition, verification, commits, deploys and talking to the user. It does **not** build: beyond trivial one-line fixes, every edit goes to an agent. Long browser QA passes go to an agent too (`sonnet`); you still look at the key screens yourself.

Commits, pushes and deploys are tail steps. Do them yourself, after the agents for that task finish, never in parallel with the edits they capture. Anything that sends, publishes, spends, deploys or is hard to reverse needs the user's approval, even when an agent could do it.

## Board tracking (optional)

Only if the user runs **Maestro** and the work outlives one turn. Use the CLI (`node <maestro-skill-dir>/maestro.mjs …`):

- `new "<title>" --repo <repo>` creates the task (one per plan task, or one for the session).
- `claim T-<id> --repo <repo>` when you start it.
- `say T-<id> "progress" --repo <repo>` at each task boundary.
- `ask T-<id> "question" --repo <repo>` when the user must decide. It lands in their inbox.
- `set T-<id> --status review --repo <repo>` when finished.
- **Never run `done` on your own work.** That's for a reviewer or the user.

No Maestro in use → skip this section entirely.

## Report

Short. Result first.

```
ORCHESTRATE  N/N complete
Result: <the one thing that matters>
Verified: <what you re-ran or looked at, and how: build/tests, screenshots, review agent>
Not verified: <anything unchecked, failed or assumed>
Open decisions: <what needs the user, if anything>
```

Add a per-task line (`[n] subagent_type · model · task  OK/FAIL`) only when there were several tasks.
