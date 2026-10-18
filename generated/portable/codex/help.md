Show a categorized cheat sheet of all available custom slash commands with one-line descriptions.

Arguments: $ARGUMENTS (optional: category name to filter, or "all" for full list)

## Instructions

Display the following skill catalog directly. Do NOT read files or run commands — just print this reference. If `$ARGUMENTS` names a category, show only that section. If empty, show all categories.

```
 SKILL CATALOG  47 custom commands

═══════════════════════════════════════════════════════════════
 WORKFLOW & PLANNING
═══════════════════════════════════════════════════════════════
 /roadmap [topic]         Socratic brainstorm → phased roadmap with tasks
 /phases [slug]           Visual roadmap progress with phase indicators
 /todo [subcommand]       Manage tasks: add, done, skip, pri, summary
 /log [text|view|wrap]    Daily work log — incremental entries, wrap-up (also one-off session notes)
 /freeze [topic|list|thaw|all] Context snapshot for cross-thread resumption
 /pre-mortem <decision>   Devil's-advocate council pre-mortem → ranked causes of death

═══════════════════════════════════════════════════════════════
 AGENT ORCHESTRATION
═══════════════════════════════════════════════════════════════
 /orchestrate <goal>      Decompose → route to specialists → gate → report
 /maestro [subcommand]    Cross-provider task board + comms: new/work/route/ask/answer/inbox/mirror
 /handoff <task>          Hand a task to Codex as a scoped GitHub issue
 /subagent <task>         Background agent: explore → implement → verify
 /parallel <a> | <b>      Run tasks simultaneously; build-check [projects|all] for shared-package consumers
 /research <topic>        Background research → structured findings
 /invert <subject>        Inversion principle: 5 failure lenses in parallel

═══════════════════════════════════════════════════════════════
 PROJECT MANAGEMENT
═══════════════════════════════════════════════════════════════
 /switch <project>        Context-switch into any project in your projects folder
 /scaffold <name> [tmpl]  New project from templates (next/vite/api/monorepo)
 /foundation-loop <dir>   Bounded harness: skeleton → working foundation (auth + 1 core flow)
 /dark-mode [where]       Light/Dark/System toggle — OS default, no-flash
 /map [project]           Architectural diagrams (Mermaid) → ARCHITECTURE.md
 /search-all <query>      Search code/files/packages across all projects
 /ai-export <plat> <url>  Export AI chat threads (ChatGPT verified) → markdown + vault
 /document <subject>      Write docs: decision records, inline, README (Notion/learnings handed off)
 /learn [text|recall]     Catalog lessons learned — gotchas, quirks, searchable index
 /note <text>             Add a note to your knowledge base (local Markdown vault)
 /motion-artifact [fmt]   Animated demo scene → deterministic GIF/MP4/WebM
 /collateral-set <client> Anchor-first set of client HTML artifacts → gated publish
 /email-triage [scope]    Triage Gmail into NEEDS YOU/WAITING/FYI/NOISE — report only

═══════════════════════════════════════════════════════════════
 CODE QUALITY
═══════════════════════════════════════════════════════════════
 /test [scope]            Run tests — auto-detects framework, parses failures
 /pr-review [PR#|branch]  Structured code review (security, logic, patterns)
 /changelog [start]       Generate changelog from git commits

═══════════════════════════════════════════════════════════════
 DIAGNOSTICS
═══════════════════════════════════════════════════════════════
 /project-health [dir]    One-shot: audit + deps + build + lint + types
 /env-check [dir]         Compare expected vs actual env vars (no secrets shown)
 /git-sync [dir]          Full git sync report: branches, ahead/behind, stashes
 /port-check              Show what's running on dev ports
 /perf [url|bundle]       Lighthouse + bundle size + Core Web Vitals
 /verify-app [url]        Verify a running app in a real browser (headless or CDP)
 /test-desktop-app <what> Test a local macOS app without stealing focus
 /report [topic]          Generate polished interactive HTML report/dashboard

═══════════════════════════════════════════════════════════════
 DATABASE
═══════════════════════════════════════════════════════════════
 /migrate [subcommand]    Migrations: generate, push, rollback, seed; status = read-only DB check

═══════════════════════════════════════════════════════════════
 DEPENDENCIES
═══════════════════════════════════════════════════════════════
 /deps [subcommand]       Audit, update, align versions across all projects

═══════════════════════════════════════════════════════════════
 INTEGRATIONS
═══════════════════════════════════════════════════════════════
 /gleap [install|api|audit] Gleap feedback SDK + REST API: wire up, query, audit
 /notion [action|ctx ...] Sync notes/decisions to Notion; ctx = cached page-summary registry
 /slack-reply <who|url>   Draft a Slack reply in your voice → staged as a draft
 /slack-ctx [action]      Slack directory: save, find, list, sync, regen, prune

═══════════════════════════════════════════════════════════════
 @REBEL/UI DESIGN SYSTEM  (only if you've installed the @rebel/ui design-system skills)
═══════════════════════════════════════════════════════════════
 /rebel-ui                Component reference — props, patterns, themes
 /setup-rebel-ui          Wire up @rebel/ui in a consumer project
 /rebel-new-component     Scaffold new component in design system
 /rebel-add-page [pattern] Scaffold page: dashboard, settings, data-table...

═══════════════════════════════════════════════════════════════
 QUICK COMBOS
═══════════════════════════════════════════════════════════════
 New project        /scaffold → /switch → /map
 Stand up foundation /scaffold → /foundation-loop → /switch
 Ship feature       /todo → code → /test → /pr-review → /changelog
 Debug issue        /project-health → /env-check → /migrate status → /verify-app
 Plan work          /roadmap → /phases → /todo
 End of day         /log wrap
 Switch threads     /freeze → new terminal → /freeze thaw
 Pre-merge          /invert <feature> → /test → /pr-review
 Big decision        /pre-mortem <decision> → resolve Tier 1 → decide
 Status report      /report <project or topic> → opens in browser
 Client collateral  fact sheet → /collateral-set → /motion-artifact for GIFs
 Design system      /rebel-new-component → /parallel build-check all
 Cross-project      /search-all → /deps align → /parallel build-check
 Wire up feedback   /gleap install → /env-check → /gleap audit
 Answer in Slack    /slack-ctx find <person> → /slack-reply <url>
```

If `$ARGUMENTS` names a specific skill (e.g., `/help migrate`), show its full description by reading that skill's file and presenting a summary. Check these locations in order and use the first that exists:
1. `~/.claude/skills/operator/<skill>/SKILL.md` (the operator-skills symlink)
2. `~/.claude/commands/<skill>.md` (the flat install)
3. `skills/<skill>/SKILL.md` in the current directory, if you're inside the operator-skills repo

If none exist, say the skill isn't installed here.

## Notes
- This is a static reference — update it when adding or removing skills, and keep the count in the header equal to the number of commands actually listed (count the lines starting with ` /`)
- The "Quick Combos" section shows common multi-skill workflows
- For Vercel plugin skills, those are injected automatically by hooks — not listed here
- For marketplace plugin skills (hookify, frontend-design, etc.), run `/skills` dialog
