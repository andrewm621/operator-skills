# Operator Skills — Claude Cowork Setup Guide

## Installation — Ask Claude to Do It

Open Cowork and send this message:

> Clone https://github.com/andrewm621/operator-skills.git to ~/operator-skills and symlink the skills directory to ~/.claude/skills/operator. Then confirm it worked by listing what's in ~/.claude/skills/operator.

Claude runs the commands and confirms the install. Type `/` — you should see all 34 skills in autocomplete.

## Manual Install (No Claude)

If you'd rather do it yourself:

**Option A — Terminal:**
```bash
git clone https://github.com/andrewm621/operator-skills.git ~/operator-skills
ln -s ~/operator-skills/skills ~/.claude/skills/operator
```

**Option B — Finder/Explorer:**
1. Download the ZIP from GitHub (Code → Download ZIP)
2. Extract it somewhere (e.g. `~/operator-skills`)
3. Show hidden files (Cmd+Shift+. on Mac)
4. Navigate to `~/.claude/skills/` (create `skills/` if it doesn't exist)
5. Drag the `skills/` folder from the extracted repo into `~/.claude/skills/` and rename it `operator`

## Global Instructions (Optional)

For auto-parallel behavior and subagent conventions, paste the following into Cowork's Global Instructions (Settings → Global Instructions):

```
When a task involves 3+ independent subtasks, default to parallel execution.
Use /research for background lookups while working on other things.
Use /parallel for simultaneous task execution.
Use /roadmap before complex features spanning 3+ files.
After changing shared code, use /parallel-check to verify consumers.
```

## How It Works

Each skill lives at `skills/<name>/SKILL.md` with YAML frontmatter:

```yaml
---
name: parallel
description: >
  Run multiple tasks in parallel using subagents.
argument-hint: "<task1> | <task2> | <task3>"
---
```

- `name` — matches the directory name, used for `/` autocomplete
- `description` — shown in the skill picker UI
- `argument-hint` — shows what arguments the skill accepts
- The body after the frontmatter is the full prompt

## Updating

Ask Claude: "pull the latest operator-skills" — or run `cd ~/operator-skills && git pull` yourself.

Skills update instantly. The symlink means Cowork always reads the latest files.

## Platform Notes

- **Cowork reads SKILL.md natively** — same format as Claude Code
- Skills that spawn subagents (`/parallel`, `/invert`, `/research`) work in Cowork
- Skills that use CLI-specific tools (browser CDP, bash commands) may have reduced functionality in Cowork compared to Claude Code
- `/verify-app` and `/perf` require a Chromium browser with CDP enabled — these are Claude Code-specific
