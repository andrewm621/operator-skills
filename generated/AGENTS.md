# AGENTS.md

Passive skill digest for **Codex, Cursor, and other AGENTS.md-aware coding
agents.** This is a reference doc, not an installable command set — Codex CLI
and Cursor pick up runnable commands from `generated/portable/codex/` (or
`generated/claude-only/codex/`) and `generated/portable/cursor/` (or
`generated/claude-only/cursor/`) respectively (see `generated/README.md`).
This file just tells an agent what capabilities exist, in one place, so it can
decide when to reach for one.

These are Andrew Miller's operator skills: real working prompts for running
50+ software projects (Next.js, Vite, Cloudflare Workers, Turborepo), not
demos. Source of truth is `skills/<name>/SKILL.md` in this repo — this file is
generated from there; edit the source, then regenerate (see
`generated/README.md`).

Skills below are split into two sections by how portable they are. See
`generate-adapters.mjs` (`CLAUDE_ONLY`) for the exact classification.

## Portable (any agent)

These skills have no dependency on Claude Code or claude.ai-specific tooling
— the instruction text works as-is in Codex, Cursor, or any other agent that
reads this file.

### All Skills

- **/changelog** — Generate a changelog from git commits since the last tag or a custom starting point.
- **/dark-mode** — Add a Light / Dark / System theme toggle to the current project, defaulting to the OS preference and persisting the user's explicit choice — flash-free, across Next.js, Vite/React, and plain HTML.
- **/db-status** — Database connection check and quick status. For full migration workflows, use `/migrate`.
- **/deps** — Dependency management across projects. Audit vulnerabilities, update packages, and align versions across the workspace.
- **/document** — Document a feature, decision, architecture, or workflow. Writes to dev-notes, Notion, or inline code docs.
- **/env-check** — Compare expected vs actual environment variables and flag mismatches. Never displays secret values.
- **/git-sync** — Full git sync report for the current repository. Shows local vs remote status, all branches, uncommitted changes, stashes, and potential conflicts. Optional: pass a project directory as argument.
- **/help** — Show a categorized cheat sheet of all available custom slash commands with one-line descriptions.
- **/learn** — Extract, catalog, and recall lessons learned — mistakes, gotchas, surprising behaviors, and solutions. Builds a searchable knowledge base from real work sessions so the same problems don't bite twice.
- **/log** — Update the daily work log — a living document that tracks progress, decisions, and context throughout the day. Creates a new log if none exists for today, or appends to the existing one.
- **/migrate** — Database migration workflow for Drizzle, Prisma, or Supabase projects. Guides through generating, reviewing, and applying migrations safely.
- **/phases** — Display the current roadmap progress with visual phase indicators. Reads from /roadmap data or any roadmap file.
- **/pr-review** — Structured code review of a pull request. Checks security, logic, patterns, and breaking changes.
- **/project-health** — One-shot health check for the current project. Delegates to specialized skills where possible and aggregates results.
- **/report** — Generate a polished, interactive HTML report for: {the text you type after the command}
- **/search-all** — Search across all ~/Projects/* directories for a pattern. Finds packages, code references, and files across 50+ projects.
- **/session-notes** — Write up a structured session note capturing what was done, decisions made, and what's next. Saves to dev-notes.
- **/switch** — Fast context switch into any project with full orientation. Fuzzy matches project names against ~/Projects/*.
- **/test** — Run and analyze tests for the current project. Detects test framework, runs targeted or full suites, and reports results with actionable fix suggestions.
- **/todo** — Manage tasks within the current roadmap phase or as a standalone list. Add, complete, skip, reprioritize, and view tasks.

## Claude Code-specific (needs Anthropic tooling/MCP)

These skills describe Claude Code tools (Agent/Task/Workflow, named
subagent_types), `mcp__claude_ai_*`/`mcp__chrome-devtools__*` MCP tools, or
the Dia Browser + `agent-browser` + CDP setup. The *instruction text* ports
to any agent that reads this file, but the skill only actually *works* where
that underlying Claude-specific tooling or MCP server is also present.

### All Skills

- **/freeze** — Preserve full conversation context for cross-thread resumption. Dumps everything Claude currently knows into a machine-loadable file that a future Claude instance can ingest to pick up exactly where you left off.
- **/invert** — Apply the inversion principle to stress-test a feature, process, or system. Instead of asking "how do we make this succeed?", spawns independent subagents that each ask "how would this fail?" from a different lens. Aggregates weaknesses into a prioritized risk report.
- **/map** — Generate or update an architectural map of a project — folder structure, dependencies, data flow, and component relationships — with Mermaid diagrams.
- **/notion** — Sync work progress, decisions, and notes to any project's Notion workspace. Auto-detects project from cwd via the notion-context registry. Creates dev notes, updates existing pages, searches for context, and keeps project workspaces current.
- **/notion-ctx** — Manage a per-project registry of relevant Notion documents with cached summaries for fast context loading. Keeps Notion knowledge fresh and token-efficient.
- **/orchestrate** — Orchestrate a goal end-to-end: decompose it, route each piece to the best specialist agent, run pieces in parallel or as a pipeline, gate quality, and report. The smart layer above /parallel and /subagent.
- **/parallel** — Run multiple tasks in parallel using subagents. Pipe-separated tasks are spawned simultaneously and results are aggregated.
- **/parallel-check** — Check if a shared dependency change breaks consumer projects. Thin wrapper around `/parallel build-check` with auto-detected consumers.
- **/perf** — Performance audit for web apps. Runs Lighthouse via Dia Browser, analyzes bundle size, checks Core Web Vitals, and suggests optimizations.
- **/port-check** — Show what's running on common development ports. Identifies projects and offers to kill stale processes.
- **/research** — Research a topic in the background using a subagent while you keep working. Returns a structured summary.
- **/roadmap** — Enter a multi-round Socratic brainstorming session to deeply explore a project idea, then generate a phased roadmap with tasks, dependencies, and unknowns.
- **/scaffold** — Create a new project from templates tuned to your stack conventions. Scaffolds full project structure with framework, database, auth, and design system pre-wired.
- **/subagent** — Dispatch a task to a background agent that explores the codebase, plans the implementation, and makes the changes — all while you keep working in the primary session.
- **/verify-app** — Verify a running web app in Dia Browser via CDP. URL defaults to http://localhost:3000 unless specified.
