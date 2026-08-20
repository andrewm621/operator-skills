# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**operator-skills** is a collection of Claude slash commands (prompt text), not an application. There is no `package.json`, no dependency tree, no test suite, and no build step beyond two zero-dependency Node scripts. The "code" is Markdown; the risk is *drift between copies of that Markdown*, and that is what nearly all tooling here exists to catch.

Consumed via a single symlink: `ln -s ~/operator-skills/skills ~/.claude/skills/operator`. Adding a folder under `skills/` is all that's needed for a skill to appear at `/` in a new session — every other surface exists for discoverability or for platforms that can't read the folder.

> **Careful:** `.claude/CLAUDE.md` in this repo is a **template artifact shipped for users to copy into their own projects** (it describes a generic multi-project workspace, TanStack Query, Zod, dev-notes). It is *not* guidance about this repo, even though Claude Code loads it as project instructions. This file is the authority for working here.

## Commands

```bash
node generate-adapters.mjs          # regenerate generated/ from skills/*/SKILL.md
node generate-adapters.mjs --out D  # generate into an arbitrary dir (used by the verifier)
node verify-adapters.mjs            # regenerate into a temp dir and diff vs committed generated/; exit 1 on drift
```

`verify-adapters.mjs` is the closest thing to a test suite. Run it before every commit that touches `skills/`.

The other four pre-commit checks are manual (from `CONTRIBUTING.md`):

```bash
ls -d skills/*/ | wc -l                              # must match the README's claimed count
grep -rn "all 3[0-9] skill\|3[0-9] custom\|3[0-9] operator" README.md docs/   # stale counts

# /help cheat sheet must be byte-identical to its mirror in the Claude.ai reference
awk '/^ SKILL CATALOG/{f=1} f{print} /Cross-project/{if(f)exit}' skills/help/SKILL.md > /tmp/a
awk '/^ SKILL CATALOG/{f=1} f{print} /Cross-project/{if(f)exit}' docs/claude-ai-skill-reference.md > /tmp/b
diff /tmp/a /tmp/b && echo "IDENTICAL"
```

To exercise a skill for real, symlink and open a new session — `/`-command definitions are read at session start, so edits never apply to the current session.

## Architecture: one source, seven surfaces

`skills/<name>/SKILL.md` is the single source of truth. Every other representation is a copy, and **nothing errors when they diverge** — that's the central hazard of this codebase.

```
skills/<name>/SKILL.md  ──┬─→ README.md                          (catalog row + count ×4)   [hand]
   frontmatter + body     ├─→ docs/claude-ai-skill-reference.md   (VERBATIM body mirror)     [hand]
                          ├─→ docs/claude-ai-project-instructions.md (row + count ×2)        [hand]
                          ├─→ docs/cowork-setup-guide.md          (count ×1)                 [hand]
                          ├─→ skills/help/SKILL.md                (cheat-sheet line + count) [hand]
                          └─→ generated/                          (Codex, Cursor, AGENTS.md) [generated]
```

The first five are hand-maintained; `generated/` is machine-produced and guarded by `verify-adapters.mjs`. `CONTRIBUTING.md` holds the authoritative add/edit checklist — **read it before touching `skills/`**.

### The three traps

1. **`docs/claude-ai-skill-reference.md` is a verbatim mirror of every skill body.** Claude.ai web can't read the folder, so all 40 bodies are flattened into one uploadable Knowledge file. Editing a skill means editing its copy there too. Subtle case: the `/help` skill's own catalog lives *inside* that mirror, so a `/help` edit must be duplicated there or the two `/help`s drift (the `diff` check above catches exactly this).
2. **There are two different skill counts and they are not the same number.** `README.md` counts folders in `skills/` (currently 40). The `/help` cheat sheet keeps its own count on a different basis — it omits some skills and includes `@rebel/ui` skills absent from the README catalog (currently 39). Do not "fix" one to match the other; bump each within its own world.
3. **`.claude/CLAUDE.md` is shipped template content, not repo instructions.** See the warning above.

### Portable vs Claude-only

`generate-adapters.mjs` sorts every skill into one of two output buckets via the curated `CLAUDE_ONLY` set at the top of the file:

- **`generated/portable/`** — instruction text works as-is in Codex, Cursor, or any agent.
- **`generated/claude-only/`** — hard-depends on Claude Code tools (Agent/Task/Workflow, named `subagent_type`s), `mcp__claude_ai_*` / `mcp__chrome-devtools__*` MCP tools, or the Dia Browser + `agent-browser` + CDP setup.

A new skill that spawns subagents, calls one of those MCP tools, or drives a browser belongs in `CLAUDE_ONLY`; everything else is portable by default and needs no entry. `CLAUDE_TOKEN_PATTERNS` is a **warning-only** safety net — it prints to stderr when the curated list and a skill's body disagree, but never fails generation. Several warnings are currently expected and benign (e.g. `/help` merely *mentions* "Dia Browser" in its cheat-sheet text). Treat them as prompts to re-verify the classification, not as build failures. `generated/AGENTS.md` mirrors the split as two labeled sections, grouped by the README's own categories — the generator **parses `README.md`'s `## Skill Catalog` section** to derive that grouping, so a malformed catalog table silently degrades AGENTS.md to a flat "Other" group.

## SKILL.md conventions

```markdown
---
name: my-skill            # MUST match the folder name exactly (the generator throws otherwise)
description: >            # one sentence; powers `/` autocomplete + Claude.ai lookup
  Folded block form when it wraps.
argument-hint: "<what to type>"   # "<required>" / "[optional]"; omit if no args
---

One-line restatement of what the skill does.

Task: $ARGUMENTS

## Steps
1. **Step name** — ...

## Notes
- Edge cases, and when *another* skill is the better tool.
```

- The frontmatter parser in `generate-adapters.mjs` is **hand-rolled on purpose** (zero deps) and handles only what SKILL.md actually uses: bare scalars, quoted scalars, and `>` folded blocks. Lists, nested maps, and `|` literal blocks will not parse.
- Cursor has no argument-substitution token, so the generator swaps `$ARGUMENTS` for a literal placeholder and prepends an `# <name>` heading if the body doesn't already start with one.
- Cross-reference sibling skills with backticked slash names (`` `/parallel` ``) so relationships stay legible.
- `.gitattributes` forces LF on all text files — the line-by-line frontmatter parser previously broke on CRLF checkouts. Don't relax it.

## Style for skill prompts

These are working commands, not demos. Specific over generic (name real tools, paths, failure modes), action-first (a numbered `## Steps` spine, not prose), and honest about scope. When adapting one of Andrew's personal commands, strip anything tied to a private setup (private index paths, named private agents, personal-voice references) and keep the software-project framing — that's the line this repo holds.
