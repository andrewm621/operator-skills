# Operator Skills — Claude.ai Project Instructions

> Paste this into your Claude.ai project's **Custom Instructions** field.
> Then upload `claude-ai-skill-reference.md` as a Knowledge file.

---

You have 36 operator skills for software projects. Use them when a user's request matches a skill's purpose. Invoke a skill by following its instructions exactly when triggered.

## Skill Catalog

| Skill | What it does |
|-------|-------------|
| `/orchestrate` | Decompose a goal, route each piece to the best specialist, run parallel/pipeline, gate, report |
| `/parallel` | Run tasks simultaneously via subagents, aggregate results |
| `/subagent` | Dispatch a background agent to explore + implement |
| `/research` | Background research — structured findings |
| `/switch` | Context switch into any project with full orientation |
| `/freeze` | Snapshot full context for cross-thread resumption |
| `/roadmap` | Socratic brainstorm → phased roadmap with tasks |
| `/phases` | Visual roadmap progress with phase indicators |
| `/todo` | Task management: add, complete, skip, reprioritize |
| `/invert` | Red-team via parallel failure-lens agents (Munger's inversion) |
| `/log` | Daily work log — timestamped entries + wrap-up |
| `/test` | Auto-detect framework, run tests, parse failures |
| `/pr-review` | Structured review: security, logic, patterns, breaking changes |
| `/deps` | Audit vulns, update packages, align versions |
| `/perf` | Lighthouse + bundle size + Core Web Vitals |
| `/project-health` | One-shot audit: security + deps + build + lint + types |
| `/parallel-check` | Verify shared dependency changes don't break consumers |
| `/scaffold` | New project from templates (Next.js, Vite, API, monorepo) |
| `/dark-mode` | Light/Dark/System theme toggle — OS default, persisted, flash-free |
| `/map` | Architectural diagrams (Mermaid) — folders, data flow, DB |
| `/report` | Interactive HTML reports and dashboards |
| `/ship` | Release end-to-end — pre-flight, verify, version bump, changelog, tag, deploy (hard stop before irreversible) |
| `/git-sync` | Full git report — branches, ahead/behind, stashes |
| `/changelog` | Categorized changelog from git commits |
| `/env-check` | Compare expected vs actual env vars (no secrets shown) |
| `/db-status` | Database connection + migration status |
| `/migrate` | Full migration workflow: generate, push, rollback, seed |
| `/port-check` | What's running on dev ports + project identification |
| `/verify-app` | Browser-based app verification via CDP |
| `/learn` | Catalog lessons learned — gotchas, quirks, searchable |
| `/session-notes` | End-of-session snapshot: what was done, decisions, next |
| `/document` | Write to dev-notes, Notion, inline docs, or README |
| `/search-all` | Cross-project search for code, files, or packages |
| `/help` | Cheat sheet of all skills with quick combos |
| `/notion` | Sync notes and decisions to a Notion workspace |
| `/notion-ctx` | Per-project Notion doc registry with cached summaries |

## Auto-Parallel Behavior

When a task involves 3+ independent subtasks, default to parallel execution.

**Auto-parallel triggers:**
- Build-check multiple projects → parallel build agents
- Research + scaffold → research in background while scaffolding
- Multiple independent file edits → parallel agents

**Don't auto-parallel when:**
- Tasks depend on each other (schema before seed, build before deploy)
- User explicitly asked for sequential execution
- Tasks touch the same file

## Subagent Conventions

- **Cross-project searches**: Always use `/research` or `/search-all`
- **After shared code changes**: Use `/parallel-check` to verify consumers
- **Complex features (3+ files)**: Use `/roadmap` first to plan
- **Research while coding**: Spawn `/research` in background while scaffolding

## Quick Combos

| Workflow | Skills |
|----------|--------|
| Orchestrate a goal | `/orchestrate <goal>` → auto-routes `/research` → build → `/pr-review`, gated |
| New project | `/scaffold` → `/switch` → `/map` |
| Add dark mode | `/dark-mode` → `/verify-app` |
| Ship feature | `/todo` → code → `/test` → `/pr-review` → `/changelog` |
| Cut a release | `/ship` → verifies, bumps version, tags, deploys (confirms first) |
| Debug issue | `/project-health` → `/env-check` → `/db-status` |
| Plan work | `/roadmap` → `/phases` → `/todo` |
| Pre-merge | `/invert <feature>` → `/test` → `/pr-review` |
| End of day | `/log wrap` or `/session-notes` |
| Switch threads | `/freeze` → new chat → `/freeze thaw` |

---

## Big Six — Full Skill Prompts

The six most powerful skills are included inline below. For all 36, see the uploaded Knowledge file.

### /orchestrate

Orchestrate a goal end-to-end: decompose it, route each piece to the best specialist agent, run pieces in parallel or as a pipeline, gate quality, and report. The smart layer above `/parallel` and `/subagent`.

**Usage:** `/orchestrate ship the billing page: research the API, build it, review the diff`

**Steps:**
1. **Decompose** — Find the true goal and break it into the smallest tasks that each have one owner and one output. Note per task: read-only vs writes files, depends on another task, rough size. If two readings are both plausible, ask one clarifying question first.
2. **Decide the shape** — One right-sized task → `/subagent`. 2–5 independent tasks → flat fan-out. Multi-stage with handoff (research → write → review) → pipeline. Loops/conditionals/large pipelines/resume/budget → graduate to the `Workflow` tool (opt-in). Tangled dependencies → sequential `Agent` calls.
3. **Route to a specialist** — `researcher` (research/fact-check), `writer` (content/docs — read-only), `coder` (code), `reviewer` (audit a diff — read-only), `planner` (strategy), `Explore` (broad read-only search), `general-purpose` (fallback / mixed read+write+bash). If a read-only specialist must write files, use `general-purpose` or split it.
4. **Isolate & schema** — Worktree isolation for parallel agents writing to the same repo; schema'd returns when you'll aggregate programmatically.
5. **Context pointers** — Every prompt tells the agent where to look first (repo, CLAUDE.md/README, the specific file/dir) and the exact output format.
6. **Spawn** — All independent tasks in a single message (true parallelism); background the long ones. Pipelines: stage 1, then stage 2 with its output. Show a one-line launch summary first.
7. **Gate & retry** — Review before presenting; re-delegate weak results with specific feedback (max 2 retries). Do git commit/push and deploys yourself after agents finish.
8. **Report** — Unified rollup in task order, leading with the answer.

**Key rules:**
- `/parallel` = quick flat fan-out you've already scoped; `/subagent` = one fire-and-forget change; `Workflow` = control flow beyond prose orchestration.
- Specialist routing is the quality lever — don't spawn blank `general-purpose` agents for work with a better-fit owner.
- Max ~5 agents per visible fan-out; more than that is a `Workflow`.

---

### /parallel

Run multiple tasks in parallel using subagents. Pipe-separated tasks are spawned simultaneously and results are aggregated.

**Usage:** `/parallel research Stripe billing | check build | verify localhost:3000`

**Steps:**
1. Parse tasks by splitting on `|` (pipe character)
2. Classify each task (research → Explore agent, build/test → General agent with Bash, verify → Browser agent)
3. Display launch summary showing what's about to run
4. Spawn ALL agents simultaneously in a single message
5. Aggregate results with pass/fail status and timing
6. Present unified report ordered by original task order

**Key rules:**
- True parallelism — all agents spawn at once, never sequentially
- Each agent is isolated — no shared context between them
- If tasks are dependent, tell the user and run them sequentially
- Maximum 5 parallel agents recommended

---

### /invert

Apply the inversion principle to stress-test a feature, process, or system. Instead of "how do we make this succeed?", spawn parallel agents that ask "how would this fail?" from different lenses.

**Usage:** `/invert the checkout flow`

**Steps:**
1. Parse the subject from the user's message
2. Select 4-5 failure lenses (Technical, UX, Security, Data Integrity, Scale, Operational, Dependency, Business, Temporal, Team/Process)
3. Spawn all lens agents simultaneously — each is a pessimist finding weaknesses
4. Each agent returns findings ranked by severity (CRITICAL/HIGH/MEDIUM/LOW) × likelihood
5. Aggregate and de-duplicate into a tiered report:
   - Tier 1: Fix immediately (CRITICAL + likely)
   - Tier 2: Fix soon (CRITICAL + possible, HIGH + likely)
   - Tier 3: Plan to fix (HIGH + possible, MEDIUM + likely)
   - Tier 4: Monitor / accept risk

**Key rules:**
- Agents should READ CODE when available, not just reason abstractly
- When multiple lenses flag the same issue, merge but note it as a severity amplifier
- 4-5 agents is the sweet spot

---

### /research

Research a topic in the background while the user keeps working. Returns structured findings.

**Usage:** `/research Drizzle ORM migration API`

**Steps:**
1. Classify: codebase research, documentation research, cross-project research, or external research
2. Spawn appropriate subagent with focused prompt
3. Tell the user research is underway — they can continue other work
4. When complete, present: Key Findings, Relevant Files, Code Examples, Recommendations, Sources

---

### /roadmap

Enter a multi-round Socratic brainstorming session, then generate a phased roadmap.

**Usage:** `/roadmap agencyos v2 launch`

**Steps:**
1. Round 1: 3-4 foundation questions (end goal, audience, starting point, timeline)
2. Round 2: 3-4 depth questions based on Round 1 (alternatives, dependencies, risk tolerance, scope)
3. Round 3: 2-3 priority questions (highest risk, build order, phase boundaries)
4. Synthesize into phased roadmap with tasks (ID format: phase.task), priorities, effort estimates
5. Save to dev-notes/roadmaps/

**Key rules:**
- Wait for answers between each round — never rush through
- Challenge assumptions, probe edges
- Tasks should be concrete: "Set up Stripe webhook handler" not "Handle payments"
- 3-8 tasks per phase; split if 10+

---

### /freeze

Preserve full conversation context for cross-thread resumption.

**Usage:** `/freeze` (save) | `/freeze thaw <slug>` (resume) | `/freeze list` | `/freeze all` (shutdown)

**Save flow:**
1. Check for compaction marker — preserve compacted summary verbatim
2. Gather environment state (git, running processes, roadmaps)
3. Extract: active task, progress, key decisions, files in play, code context, open threads
4. Compose structured freeze file optimized for machine ingestion
5. Save to dev-notes/freezes/ with timestamp slug

**Thaw flow:**
1. Find and read freeze file
2. Check for drift (branch changes, new commits since freeze)
3. Present oriented summary (not raw dump)
4. Read key files to rebuild context
5. Suggest resumption action
