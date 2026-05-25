# CLAUDE.md — Operator Skills Template

This is a template showing how custom skills wire together at the project level. Copy this to your project's `.claude/CLAUDE.md` (or root `CLAUDE.md`) and adapt the paths, project names, and conventions to your setup.

## Skill Structure

Skills live at `skills/<name>/SKILL.md` with YAML frontmatter for discoverability. Install via symlink:

```bash
ln -s ~/operator-skills/skills ~/.claude/skills/operator
```

Works with Claude Code (CLI), Claude Cowork (desktop), and Claude.ai (web — see `docs/`).

## Overview

<!-- Replace with your project/workspace description -->
This workspace contains multiple independent projects. Each subdirectory has its own package manager, framework, and deployment target.

## Subagent & Search Patterns

Use subagents aggressively for multi-project work:

- **Cross-project searches** ("Where do I use Stripe?", "Which projects use Supabase Auth?"): Always use `/research` or `/search-all` — don't manually grep across directories.
- **Changing shared code**: After editing a shared package, spawn parallel build-check agents for consumer projects with `/parallel-check`.
- **Research while coding**: When implementing a third-party integration, spawn `/research` in the background while scaffolding. The research runs in parallel with your coding.
- **Complex features**: Use `/roadmap` first for features spanning 3+ files or involving schema changes, auth changes, or new API routes.
- **Debugging production issues**: Use `/env-check` and `/db-status` before guessing. Check deployment logs if available.

## Auto-Parallel Behavior

When a task involves 3+ independent subtasks, default to parallel agent execution. "Independent" = tasks don't depend on each other's output.

**Auto-parallel triggers:**
- Build-check multiple projects → parallel build agents
- Edit multiple independent files → parallel edit agents
- Research + scaffold → research agent in background while scaffolding

**Don't auto-parallel when:**
- Tasks depend on each other (schema before seed, build before deploy)
- User explicitly asked for sequential execution
- Tasks touch the same file

When spawning parallel agents, briefly say: "Running these N tasks in parallel: [list]."
Don't ask permission — just do it.

## Dev Notes — Decision & Learning Log

<!-- Adapt paths to your setup. These use Claude Code's project memory directories. -->
A persistent historical record lives at `~/.claude/projects/<your-project-path>/dev-notes/`. Unlike memory (what's true now), dev notes track what happened and why (append-only).

**When to log:**
- **Decisions** (`decisions/YYYY-MM-DD-topic.md`): Any architecture choice, tech selection, or design decision with non-obvious rationale. Skip routine choices.
- **Learnings** (`learnings/YYYY-MM-DD-topic.md`): Technical insights that aren't obvious from the code — gotchas, surprising behaviors, performance discoveries, integration quirks.
- **Sessions** (`sessions/YYYY-MM-DD-summary.md`): After substantial work sessions — what was done, files changed, what's next.
- **Freezes** (`freezes/YYYY-MM-DD-HHmm-slug.md`): Context snapshots for cross-thread resumption via `/freeze`.

**Always update `INDEX.md`** when adding entries.

**Format for decisions:**
```markdown
# Decision: [Title]
Date: YYYY-MM-DD | Status: Proposed/Implemented/Superseded
Projects: [which projects]
## Context — why this decision was needed
## Decision — what was chosen
## Alternatives — what was considered and rejected
```

## Memory Files

<!-- Claude Code auto-memory lives alongside dev notes. These are "what's true now" vs dev notes' "what happened." -->
Memory files at `~/.claude/projects/<your-project-path>/memory/` store current project state:

| File | Purpose |
|------|---------|
| `MEMORY.md` | Auto-memory — key facts, URLs, configs, pricing, etc. |
| Additional `.md` files | Topic-specific context (e.g., `content-pipeline.md`, `locked-decisions.md`) |

Skills that interact with memory:
- `/learn` writes to `dev-notes/learnings/` and suggests memory updates for recurring patterns
- `/log wrap` and `/session-notes` extract decisions and learnings from the day's work
- `/freeze` captures everything needed to resume in a new thread
- `/document` writes to dev-notes, Notion, or inline docs depending on the target

## Skill Composition Patterns

Skills are designed to call each other. Key composition patterns:

### Plan → Execute → Track
```
/roadmap <topic>       → Generates phased roadmap
/phases                → Shows progress
/todo                  → Manages tasks
/todo done <id>        → Marks complete
/parallel phase N      → Runs phase tasks in parallel
```

### Build → Verify → Ship
```
/test                  → Run tests
/pr-review             → Structured code review
/invert <feature>      → Red-team analysis
/changelog             → Generate changelog
```

### Diagnose → Fix
```
/project-health        → One-shot health check
/env-check             → Environment variable audit
/db-status             → Database connection + migration check
/verify-app            → Browser verification
```

### Knowledge Capture
```
/log                   → Incremental daily entries
/log wrap              → End-of-day summary with extracted decisions/learnings
/learn                 → Capture specific gotchas and quirks
/session-notes         → One-shot session snapshot
/freeze                → Full context preservation for thread switching
```

## Project Conventions

<!-- Adapt these to your stack -->
- Components: function declarations (not arrows), named exports only
- `"use client"` only where needed, pushed as far down the tree as possible
- Validation: Zod everywhere
- State: TanStack Query for server state, Zustand for complex client state
- Colors: use semantic tokens — never hardcode hex values
