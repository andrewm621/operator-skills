# Operator Skills — Claude Cowork Setup Guide

Claude Cowork (the desktop app) reads skills from the same `~/.claude/skills/` directory as Claude Code. Setup is identical.

## Installation

```bash
# Clone the repo
git clone https://github.com/andrewm621/operator-skills.git ~/operator-skills

# Symlink into Claude's skills directory
ln -s ~/operator-skills/skills ~/.claude/skills/operator
```

## Verify

Open Claude Cowork and type `/` — you should see all 33 operator skills in autocomplete.

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

```bash
cd ~/operator-skills && git pull
```

Skills update instantly — no restart needed. The symlink means Cowork always reads the latest files.

## Platform Notes

- **Cowork reads SKILL.md natively** — same format as Claude Code
- Skills that spawn subagents (`/parallel`, `/invert`, `/research`) work in Cowork
- Skills that use CLI-specific tools (browser CDP, bash commands) may have reduced functionality in Cowork compared to Claude Code
- `/verify-app` and `/perf` require a Chromium browser with CDP enabled — these are Claude Code-specific
