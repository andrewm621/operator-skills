# Generated Adapters

This directory is **generated, not hand-edited.** It's produced from the canonical
sources at `skills/*/SKILL.md` by `generate-adapters.mjs` at the repo root — the same
way `docs/claude-ai-skill-reference.md` is a mirror of the skill bodies (see
`CONTRIBUTING.md`). If you edit a `SKILL.md`, regenerate this directory before
committing, or `verify-adapters.mjs` will fail the build.

## What's here

Every skill is classified as **portable** (no dependency on Claude Code/claude.ai-
specific tooling — works as-is in any agent) or **claude-only** (hard-depends on
Claude Code tools, named subagent_types, `mcp__claude_ai_*`/`mcp__chrome-devtools__*`
MCP tools, or the Dia Browser + `agent-browser` + CDP setup). The curated
classification lives in `CLAUDE_ONLY` in `generate-adapters.mjs`.

```
generated/
  portable/
    codex/<name>.md    cursor/<name>.md
  claude-only/
    codex/<name>.md    cursor/<name>.md
  AGENTS.md
  README.md
```

| Path | Format | Installs to |
|------|--------|-------------|
| `portable/codex/<name>.md`, `claude-only/codex/<name>.md` | Codex CLI prompt — frontmatter stripped, body verbatim, `$ARGUMENTS`/`$1..$9` kept | `~/.codex/prompts/` |
| `portable/cursor/<name>.md`, `claude-only/cursor/<name>.md` | Cursor command — `$ARGUMENTS` replaced with a readable placeholder, heading added if missing | `~/.cursor/commands/` (global) or `<project>/.cursor/commands/` |
| `AGENTS.md` | One passive digest of every skill, split into "Portable" and "Claude Code-specific" sections, grouped by category within each | Drop into any repo an AGENTS.md-aware agent reads |

## Regenerate

```bash
node generate-adapters.mjs
```

## Verify (no drift between skills/ and generated/)

```bash
node verify-adapters.mjs
```

Run this after any edit to a `SKILL.md` — same discipline the six-surfaces checklist
in `CONTRIBUTING.md` already asks for on the other surfaces. It regenerates into a
temp dir and diffs it against the committed `generated/` tree; any difference exits
non-zero.

## Install

Mirrors the existing Claude Code symlink pattern (`ln -s ~/operator-skills/skills
~/.claude/skills/operator`). **`portable/` is the primary path for other agents** —
it works everywhere with no extra setup. `claude-only/` is available too, but each
skill in it only actually works where the underlying Claude Code tooling or MCP
server it describes is also present in your agent's host environment.

**Codex CLI (portable skills):**

```bash
ln -s ~/operator-skills/generated/portable/codex ~/.codex/prompts
```

(If `~/.codex/prompts` already has content you want to keep, symlink or copy
individual files instead: `cp ~/operator-skills/generated/portable/codex/*.md ~/.codex/prompts/`.)

**Codex CLI (claude-only skills too, only if your host has the matching tooling/MCP):**

```bash
cp ~/operator-skills/generated/claude-only/codex/*.md ~/.codex/prompts/
```

**Cursor (global commands, available in every project — portable skills):**

```bash
mkdir -p ~/.cursor/commands
ln -s ~/operator-skills/generated/portable/cursor/*.md ~/.cursor/commands/
```

**Cursor (project-local commands, one project only — portable skills):**

```bash
mkdir -p .cursor/commands
ln -s ~/operator-skills/generated/portable/cursor/*.md .cursor/commands/
```

**Cursor (claude-only skills too, only if your host has the matching tooling/MCP):**

```bash
cp ~/operator-skills/generated/claude-only/cursor/*.md ~/.cursor/commands/
```

**AGENTS.md digest** — copy or symlink into any repo you want an agent to read it in:

```bash
cp ~/operator-skills/generated/AGENTS.md ~/some-project/AGENTS.md
```
