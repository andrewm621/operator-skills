# Operator Skills

**Claude slash commands for people who build things.**

39 custom skills that turn Claude into a full operating system for software projects. Not demos — the actual commands I use daily to run 50+ projects across Next.js, Vite, Cloudflare Workers, and Turborepo monorepos.

They started as one-off prompts, became reusable slash commands, then became a system where skills call other skills — roadmaps feed into phases, phases feed into todos, todos feed into parallel agents, and everything gets logged. This is that system, open-sourced.

Works with **Claude Code** (CLI), **Claude Cowork** (desktop), and **Claude.ai** (web).

## Setup

### Claude.ai (Web) — No CLI Needed

1. **Project Instructions** — Create a Claude.ai project, open Settings → Custom Instructions, paste the contents of [`docs/claude-ai-project-instructions.md`](docs/claude-ai-project-instructions.md)
2. **Knowledge File** — Click "Add Knowledge" → upload [`docs/claude-ai-skill-reference.md`](docs/claude-ai-skill-reference.md)

Ask Claude "what skills do you have?" to confirm. Invoke them naturally: "run /parallel on these three tasks" or "use /invert on the checkout flow."

### Claude Cowork (Desktop) — Let Claude Install It

Open Cowork and send this message:

> Clone https://github.com/andrewm621/operator-skills.git to ~/operator-skills and symlink the skills directory to ~/.claude/skills/operator

Claude runs the commands for you. Type `/` to see all 39 skills in autocomplete.

See [`docs/cowork-setup-guide.md`](docs/cowork-setup-guide.md) for manual install and optional Global Instructions.

### Claude Code (CLI)

```bash
git clone https://github.com/andrewm621/operator-skills.git ~/operator-skills
ln -s ~/operator-skills/skills ~/.claude/skills/operator
```

Type `/` in a new session to see all 39 skills.

## Skill Catalog

### Orchestration

| Skill | What it does | Example |
|-------|-------------|---------|
| `/orchestrate` | Decompose a goal, route each piece to the best specialist, run parallel/pipeline, gate, report | `/orchestrate ship the billing page: research, build, review` |
| `/parallel` | Run tasks simultaneously, aggregate results | `/parallel research Stripe billing \| check build \| verify localhost:3000` |
| `/subagent` | Dispatch a background agent to explore + implement | `/subagent add email notifications to the API` |
| `/research` | Background research — structured findings while you keep working | `/research Drizzle ORM migration API` |
| `/switch` | Context switch into any project with full orientation | `/switch agencyos` |
| `/freeze` | Snapshot full context for cross-thread resumption | `/freeze` to save, `/freeze thaw` to resume |

### Planning

| Skill | What it does | Example |
|-------|-------------|---------|
| `/roadmap` | Socratic brainstorm → phased roadmap with tasks and dependencies | `/roadmap agencyos v2 launch` |
| `/phases` | Visual roadmap progress with phase indicators | `/phases` |
| `/todo` | Task management — add, complete, skip, reprioritize | `/todo done 2.3` |
| `/invert` | Red-team via 5 parallel failure-lens agents (Munger's inversion) | `/invert the checkout flow` |
| `/log` | Daily work log — timestamped entries + end-of-day wrap-up | `/log` or `/log wrap` |

### Code Quality

| Skill | What it does | Example |
|-------|-------------|---------|
| `/test` | Auto-detect framework, run tests, parse failures, suggest fixes | `/test coverage` |
| `/pr-review` | Structured review — security, logic, patterns, breaking changes | `/pr-review 47` |
| `/deps` | Audit vulns, update packages, align versions across projects | `/deps align stripe` |
| `/perf` | Lighthouse + bundle size + Core Web Vitals | `/perf` |
| `/project-health` | One-shot audit: security + deps + build + lint + types | `/project-health` |
| `/parallel-check` | Verify a shared dependency change doesn't break consumers | `/parallel-check all` |

### Scaffolding & Architecture

| Skill | What it does | Example |
|-------|-------------|---------|
| `/scaffold` | New project from templates — DB, auth, UI pre-wired | `/scaffold my-app next` |
| `/dark-mode` | Light/Dark/System theme toggle — OS default, persisted, flash-free | `/dark-mode` |
| `/map` | Architectural diagrams (Mermaid) — folders, data flow, DB schema | `/map` |
| `/report` | Interactive HTML reports and dashboards | `/report sprint 3 review` |
| `/motion-artifact` | Animated product-demo scenes in HTML → deterministic GIF/MP4/WebM export | `/motion-artifact onboarding flow gif` |

### Git & Infrastructure

| Skill | What it does | Example |
|-------|-------------|---------|
| `/git-sync` | Full git report — branches, ahead/behind, stashes, conflicts | `/git-sync` |
| `/changelog` | Categorized changelog from git commits since a tag | `/changelog v1.2.0` |
| `/env-check` | Compare expected vs actual env vars (never displays secrets) | `/env-check` |
| `/db-status` | Database connection, migration status, table inventory | `/db-status` |
| `/migrate` | Full migration workflow — generate, review, apply, rollback | `/migrate generate` |
| `/port-check` | What's running on dev ports + project identification | `/port-check` |
| `/verify-app` | Browser-based app verification via CDP — screenshots + errors | `/verify-app` |
| `/gleap` | Gleap feedback SDK + REST API — install, query, audit an integration | `/gleap audit` |

### Knowledge

| Skill | What it does | Example |
|-------|-------------|---------|
| `/learn` | Catalog lessons learned — gotchas, quirks, searchable index | `/learn recall supabase auth` |
| `/session-notes` | End-of-session snapshot — what was done, decisions, next steps | `/session-notes` |
| `/document` | Write to dev-notes, Notion, inline docs, or README | `/document decision: why we chose Drizzle` |
| `/search-all` | Cross-project search for code, files, or packages | `/search-all pkg:stripe` |
| `/help` | Cheat sheet of all skills with quick combos | `/help` |
| `/notion` | Sync notes and decisions to a Notion workspace | `/notion note "Shipped auth flow"` |
| `/notion-ctx` | Per-project Notion doc registry with cached summaries | `/notion-ctx sync` |
| `/slack-reply` | Draft a Slack reply in your voice — resolves the thread, stages a draft | `/slack-reply josh re: the UTI timeline` |
| `/slack-ctx` | Local Slack directory — people, channels, threads, cached ids | `/slack-ctx save <url> josh` |

## How They Compose

Individual skills are useful. The system is where it gets interesting — skills share data formats, reference each other's output, and chain together.

### Pattern 1: Orchestrate a Whole Goal

```
/orchestrate ship the billing page: research the Stripe API, build it, review the diff
```

This is the smart layer above the rest. `/orchestrate` decomposes the goal, picks the *shape* (flat fan-out, pipeline, or — for loops and large batches — graduates to a Workflow), routes each piece to the best-fit specialist (`researcher` → `coder` → `reviewer`), runs them in parallel or as a sequenced pipeline, gates quality, and reports a unified rollup. Reach for it when the work is substantive and multi-step; drop to `/parallel` or `/subagent` when you've already scoped the shape yourself.

### Pattern 2: Parallel Everything

```
/parallel research Stripe billing | check agencyos build | verify localhost:3000
```

This spawns three independent agents simultaneously. One researches an API, one runs a build, one verifies a running app. Results come back aggregated with pass/fail status and timing. No waiting for sequential execution.

### Pattern 3: Plan, Execute, Track

```
/roadmap agencyos v2 launch
```

This kicks off a Socratic brainstorming session — three rounds of structured questions that challenge assumptions and probe edges. The output is a phased roadmap with tasks, priorities, effort estimates, and unknowns.

Then the execution loop:

```
/phases                    # See where you are
/todo                      # See current tasks
/todo done 2.3             # Mark task complete
/parallel phase 2          # Run all Phase 2 tasks in parallel
/phases update 2 completed # Move to next phase
```

The roadmap, phases, and todos all read/write the same file. Progress flows through the system.

### Pattern 4: Red Team Before Shipping

```
/invert the checkout flow
```

This spawns 4-5 parallel agents, each examining your feature through a different failure lens: technical edge cases, security exploits, UX dead ends, data integrity, dependency failures. Each agent reads your actual code — not abstract reasoning. Results come back as a tiered risk report (fix immediately / fix soon / plan to fix / accept risk).

Combine with `/pr-review` and `/test` for a pre-merge gauntlet:

```
/invert the checkout flow   # Find weaknesses
/test                       # Run the suite
/pr-review                  # Structured review
```

## The CLAUDE.md Template

The [`.claude/CLAUDE.md`](.claude/CLAUDE.md) template shows how skills wire together at the project level: auto-parallel behavior, subagent conventions, dev notes, and memory file patterns. Copy it and adapt the paths to your setup.

## Customization

- **Paths** — Several skills reference `~/Projects/`. Adapt to your directory structure.
- **Notion** — `/notion` and `/notion-ctx` need a Notion MCP server. Skip them if you don't use Notion.
- **Browser tools** — `/verify-app` and `/perf` use Chrome DevTools Protocol (any Chromium browser on port 9222). These are Claude Code-specific.
- **`/scaffold`** — Opinionated toward my stack (Next.js, Neon, Drizzle). Fork the templates for yours.

The best skills are the ones you modify to match how you actually work.

## Contributing

Adding or editing a skill? See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: a skill is registered in six places (the `SKILL.md`, the README catalog + count, both Claude.ai docs, the Cowork guide, and the `/help` cheat sheet), and `docs/claude-ai-skill-reference.md` is a verbatim mirror of the skill bodies — keep them in sync or the web version drifts. The checklist and a verify script are in that file.

## Platform Compatibility

| Feature | Code (CLI) | Cowork (Desktop) | Claude.ai (Web) |
|---------|-----------|-----------------|-----------------|
| All 39 skills | Full | Full | Full |
| `/` autocomplete | Native | Native | Manual invoke |
| Subagent spawning | Full | Full | Simulated |
| File system access | Full | Full | Via Knowledge files |
| Browser CDP tools | Full | Limited | Not available |
| Git operations | Full | Full | Not available |

## Builder's Loft

These skills are free. Take them, use them, modify them.

The walkthrough of how these skills evolved, live builds of new ones, the working docs behind every Builder's Field Notes piece, and the full agency operating system — that's [Builder's Loft](https://community.buildersloft.com).

The Lobby is free. Come say hi.

## License

MIT -- see [LICENSE](LICENSE).

Built by [Andrew Miller](https://github.com/andrewm621).
