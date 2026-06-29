---
name: help
description: >
  Show a categorized cheat sheet of all available custom slash commands with one-line descriptions.
argument-hint: "[category] or all"
---

Show a categorized cheat sheet of all available custom slash commands with one-line descriptions.

Arguments: $ARGUMENTS (optional: category name to filter, or "all" for full list)

## Instructions

Display the following skill catalog directly. Do NOT read files or run commands — just print this reference. If `$ARGUMENTS` names a category, show only that section. If empty, show all categories.

```
 SKILL CATALOG  35 custom commands

═══════════════════════════════════════════════════════════════
 WORKFLOW & PLANNING
═══════════════════════════════════════════════════════════════
 /roadmap [topic]         Socratic brainstorm → phased roadmap with tasks
 /phases [slug]           Visual roadmap progress with phase indicators
 /todo [subcommand]       Manage tasks: add, done, skip, pri, summary
 /log [text|view|wrap]    Daily work log — incremental entries, wrap-up
 /session-notes [topic]   End-of-session snapshot (when /log wasn't used)
 /freeze [topic|list|thaw|all] Context snapshot for cross-thread resumption

═══════════════════════════════════════════════════════════════
 AGENT ORCHESTRATION
═══════════════════════════════════════════════════════════════
 /orchestrate <goal>      Decompose → route to specialists → gate → report
 /subagent <task>         Background agent: explore → implement → verify
 /parallel <a> | <b>      Run tasks simultaneously, aggregate results
 /research <topic>        Background research → structured findings
 /invert <subject>        Inversion principle: 5 failure lenses in parallel

═══════════════════════════════════════════════════════════════
 PROJECT MANAGEMENT
═══════════════════════════════════════════════════════════════
 /switch <project>        Context-switch into any ~/Projects/* project
 /scaffold <name> [tmpl]  New project from templates (next/vite/api/monorepo)
 /dark-mode [where]       Light/Dark/System toggle — OS default, no-flash
 /map [project]           Architectural diagrams (Mermaid) → ARCHITECTURE.md
 /search-all <query>      Search code/files/packages across all projects
 /document <subject>      Write docs to dev-notes, Notion, inline, or README

═══════════════════════════════════════════════════════════════
 CODE QUALITY
═══════════════════════════════════════════════════════════════
 /test [scope]            Run tests — auto-detects framework, parses failures
 /pr-review [PR#|branch]  Structured code review (security, logic, patterns)
 /changelog [start]       Generate changelog from git commits
 /ship [bump|version]     Release: pre-flight → verify → bump → tag → deploy

═══════════════════════════════════════════════════════════════
 DIAGNOSTICS
═══════════════════════════════════════════════════════════════
 /project-health [dir]    One-shot: audit + deps + build + lint + types
 /env-check [dir]         Compare expected vs actual env vars (no secrets shown)
 /db-status [dir]         Database connection + migration status (read-only)
 /git-sync [dir]          Full git sync report: branches, ahead/behind, stashes
 /port-check              Show what's running on dev ports
 /perf [url|bundle]       Lighthouse + bundle size + Core Web Vitals
 /verify-app [url]        Verify running app via Dia Browser + CDP
 /report [topic]          Generate polished interactive HTML report/dashboard

═══════════════════════════════════════════════════════════════
 DATABASE
═══════════════════════════════════════════════════════════════
 /migrate [subcommand]    Full migration workflow: generate, push, rollback, seed

═══════════════════════════════════════════════════════════════
 DEPENDENCIES
═══════════════════════════════════════════════════════════════
 /deps [subcommand]       Audit, update, align versions across all projects

═══════════════════════════════════════════════════════════════
 @REBEL/UI DESIGN SYSTEM
═══════════════════════════════════════════════════════════════
 /rebel-ui                Component reference — props, patterns, themes
 /setup-rebel-ui          Wire up @rebel/ui in a consumer project
 /rebel-new-component     Scaffold new component in design system
 /rebel-add-page [pattern] Scaffold page: dashboard, settings, data-table...
 /parallel-check [all]    Check if design system changes break consumers

═══════════════════════════════════════════════════════════════
 QUICK COMBOS
═══════════════════════════════════════════════════════════════
 New project        /scaffold → /switch → /map
 Ship feature       /todo → code → /test → /pr-review → /changelog
 Debug issue        /project-health → /env-check → /db-status → /verify-app
 Plan work          /roadmap → /phases → /todo
 End of day         /log wrap  (or /session-notes if no log entries)
 Switch threads     /freeze → new terminal → /freeze thaw
 Pre-merge          /invert <feature> → /test → /pr-review
 Status report      /report <project or topic> → opens in browser
 Design system      /rebel-new-component → /parallel-check all
 Cross-project      /search-all → /deps align → /parallel build-check
```

If `$ARGUMENTS` names a specific skill (e.g., `/help migrate`), show its full description by reading `~/.claude/commands/<skill>.md` and presenting a summary.

## Notes
- This is a static reference — update it when adding new skills
- The "Quick Combos" section shows common multi-skill workflows
- For Vercel plugin skills, those are injected automatically by hooks — not listed here
- For marketplace plugin skills (hookify, frontend-design, etc.), run `/skills` dialog
