# Operator Skills

**Claude Code slash commands for people who build things.**

33 custom skills that turn Claude Code into a full operating system for software projects. Not demos — the actual commands I use daily to run 50+ projects across Next.js, Vite, Cloudflare Workers, and Turborepo monorepos.

They started as one-off prompts, became reusable slash commands, then became a system where skills call other skills — roadmaps feed into phases, phases feed into todos, todos feed into parallel agents, and everything gets logged. This is that system, open-sourced.

**Requires:** [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

## Quick Start

```bash
# Option 1: Copy everything
cp skills/*.md ~/.claude/commands/

# Option 2: Symlink (stays in sync with git pull)
for f in /path/to/operator-skills/skills/*.md; do ln -s "$f" ~/.claude/commands/; done

# Option 3: Cherry-pick
cp skills/parallel.md skills/invert.md skills/freeze.md ~/.claude/commands/
```

Open a new Claude Code session and type `/` to see your commands.

## Skill Catalog

### Orchestration

| Skill | What it does | Example |
|-------|-------------|---------|
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
| `/perf` | Lighthouse + bundle size + Core Web Vitals | `/perf http://localhost:3000` |
| `/project-health` | One-shot audit: security + deps + build + lint + types | `/project-health` |
| `/parallel-check` | Verify a shared dependency change doesn't break consumers | `/parallel-check all` |

### Scaffolding & Architecture

| Skill | What it does | Example |
|-------|-------------|---------|
| `/scaffold` | New project from templates — DB, auth, UI pre-wired | `/scaffold my-app next` |
| `/map` | Architectural diagrams (Mermaid) — folders, data flow, DB schema | `/map` |
| `/report` | Interactive HTML reports and dashboards | `/report sprint 3 review` |

### Git & Infrastructure

| Skill | What it does | Example |
|-------|-------------|---------|
| `/git-sync` | Full git report — branches, ahead/behind, stashes, conflicts | `/git-sync` |
| `/changelog` | Categorized changelog from git commits since a tag | `/changelog v1.2.0` |
| `/env-check` | Compare expected vs actual env vars (never displays secrets) | `/env-check` |
| `/db-status` | Database connection, migration status, table inventory | `/db-status` |
| `/migrate` | Full migration workflow — generate, review, apply, rollback | `/migrate generate` |
| `/port-check` | What's running on dev ports + project identification | `/port-check` |
| `/verify-app` | Browser-based app verification via CDP — screenshots + errors | `/verify-app http://localhost:3000` |

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

## How They Compose

Individual skills are useful. The system is where it gets interesting — skills share data formats, reference each other's output, and chain together.

### Pattern 1: Parallel Everything

```
/parallel research Stripe billing | check agencyos build | verify localhost:3000
```

This spawns three independent agents simultaneously. One researches an API, one runs a build, one verifies a running app. Results come back aggregated with pass/fail status and timing. No waiting for sequential execution.

### Pattern 2: Plan, Execute, Track

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

### Pattern 3: Red Team Before Shipping

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
- **Browser tools** — `/verify-app` and `/perf` use Chrome DevTools Protocol (any Chromium browser on port 9222).
- **`/scaffold`** — Opinionated toward my stack (Next.js, Neon, Drizzle). Fork the templates for yours.

The best skills are the ones you modify to match how you actually work.

## Builder's Loft

These skills are free. Take them, use them, modify them.

The walkthrough of how these skills evolved, live builds of new ones, the working docs behind every Builder's Field Notes piece, and the full agency operating system — that's [Builder's Loft](https://community.buildersloft.com).

The Lobby is free. Come say hi.

## License

MIT -- see [LICENSE](LICENSE).

Built by [Andrew Miller](https://github.com/andrewm621).
