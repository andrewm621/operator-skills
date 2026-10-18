# Contributing

Thanks for wanting to add or improve a skill. This repo is a flat collection of Claude slash commands — no build step, no dependencies. The only thing that takes care is **keeping a skill consistent across the places it's referenced**, because a skill is registered in more than one file and nothing errors when they drift.

Read this once before adding a skill. The [Adding a skill checklist](#adding-a-skill) is the part that matters.

## What a skill is

Each skill is one folder under `skills/` containing a single `SKILL.md`:

```
skills/
  orchestrate/
    SKILL.md
```

The whole `skills/` directory is exposed to Claude Code/Cowork via one symlink:

```bash
ln -s ~/operator-skills/skills ~/.claude/skills/operator
```

So adding a folder is all it takes for the skill to appear at `/` in a new session. The extra surfaces below exist for **discoverability** (the README catalog) and for **Claude.ai web users**, who can't read the folder and instead get the skills flattened into two uploadable docs.

## Skill file format

`SKILL.md` starts with YAML frontmatter, then the prompt body:

```markdown
---
name: my-skill
description: >
  One sentence describing what the skill does. This powers `/` autocomplete
  and the Claude.ai knowledge lookup, so make it specific.
argument-hint: "<what to type after the command>"
---

One-line restatement of what the skill does.

Task: $ARGUMENTS

## Steps

1. **Step name** — what to do...
2. ...

## Notes
- Edge cases, related skills, when to reach for something else.
```

Conventions:

- **`name`** matches the folder name exactly (kebab-case), and is what the user types: `name: my-skill` → `/my-skill`.
- **`description`** is one sentence. Use the `>` folded-block form if it wraps.
- **`argument-hint`** shows in autocomplete. Use `"<required>"` / `"[optional]"`; omit if the skill takes no args.
- Reference arguments as **`$ARGUMENTS`** in the body.
- Use a **`## Steps`** numbered list as the spine, and a **`## Notes`** section for edge cases and cross-references to related skills.
- Cross-reference other skills with backticked slash names (`` `/parallel` ``) so the relationships are legible.

The fastest way to get the shape right is to copy an existing skill that resembles yours (e.g. `skills/subagent/SKILL.md` for an agent-style skill).

## Adding a skill

A skill is registered in **eight surfaces**. Update all of them — then run `node verify-adapters.mjs`, which fails on the drift that used to be silent.

- [ ] **1. `skills/<name>/SKILL.md`** — create the folder and file (frontmatter + body, per above).
- [ ] **2. `README.md`** — add a row to the right category table under `## Skill Catalog` (Orchestration, Planning, Code Quality, Scaffolding & Architecture, Git & Infrastructure, or Knowledge), **and** bump the skill count, which appears **4×**:
  - the intro line ("N custom skills…")
  - the Cowork autocomplete line ("see all N skills")
  - the CLI autocomplete line ("see all N skills")
  - the Platform Compatibility table ("All N skills")
- [ ] **3. `docs/claude-ai-skill-reference.md`** — insert the skill's **full prompt text** in its alphabetical slot, formatted as `## /name`, the body, then a `---` separator. Bump the count in the intro line (1×). *(See the [verbatim-mirror trap](#two-traps) below — this file mirrors the skill bodies.)*
- [ ] **4. `docs/claude-ai-project-instructions.md`** — add a row to the `## Skill Catalog` table and a row to `## Quick Combos` if it fits a workflow; bump the count (appears **2×**). Optionally promote it into the inline "Big N — Full Skill Prompts" set (rename the heading + add the inline prompt).
- [ ] **5. `docs/cowork-setup-guide.md`** — bump the count (1×).
- [ ] **6. `skills/help/SKILL.md`** — add the skill under the matching category block in the `/help` cheat sheet, and bump **its own count** (see trap #2).
- [ ] **7. `generated/`** — run `node generate-adapters.mjs` (see [below](#the-generated-surface)).
- [ ] **8. `~/.agents/skills/<name>`** — Delta and Zed discover skills there, and a whole-directory symlink to `skills/<name>` keeps it drift-free. Run `./install-global.sh` (it links every skill and converges old-form entries); `node verify-adapters.mjs` checks it. Override the location with `AGENTS_SKILLS_DIR`.

## Two traps

These are the two things that have actually bitten this repo.

**1. `docs/claude-ai-skill-reference.md` is a verbatim mirror of the skill files.** The Claude.ai web client can't read the `skills/` folder, so every `SKILL.md` is flattened into this one uploadable Knowledge file. That means **editing any skill requires editing its copy here too**, or the web version diverges from the real one. The subtle case: the `/help` skill (its catalog + quick combos) lives *inside* this mirror — so a `/help` edit must be duplicated in `skill-reference.md`, or the two `/help`s drift.

**2. There are two different skill counts, and they are not the same number.** `README.md`'s count is the number of folders in `skills/`. The `/help` cheat sheet keeps its **own** count on a different basis (it omits some skills and includes `@rebel/ui` skills that aren't in the README catalog). Don't "fix" one to match the other — bump each within its own world.

## Verify before committing

```bash
node verify-adapters.mjs
```

That one command replaces the old manual folder-count, stale-count `grep` and `/help` `diff` steps, and CI runs it on every push and PR. It derives every number from the `skills/*/` folders (nothing is hardcoded) and exits 1, naming each problem, if any of these drifted:

- `generated/` (Codex + Cursor + `AGENTS.md`) no longer matches `skills/*/SKILL.md`
- a skill body differs from its `## /name` section in `docs/claude-ai-skill-reference.md`, or a section is missing or orphaned
- a "N skills" claim in `README.md`, `docs/claude-ai-skill-reference.md`, `docs/claude-ai-project-instructions.md` or `docs/cowork-setup-guide.md` differs from the folder count
- a skill is missing from the `## Skill Catalog` in `README.md` or `docs/claude-ai-project-instructions.md`
- the `/help` cheat sheet differs from its mirror in the reference doc, or its stated count differs from the commands it lists
- a frontmatter `name` doesn't match its folder
- a skill isn't symlinked into `~/.agents/skills` (run `./install-global.sh`; `node verify-adapters.mjs --skip-install` skips this one, as CI does, and `AGENTS_SKILLS_DIR` overrides the location)

Then try it live: `ln -sf "$PWD/skills" ~/.claude/skills/operator`, open a new Claude Code session and type `/<name>`.

<a id="the-generated-surface"></a>
The **seventh surface**, past the six hand-edited ones above: `generated/` transpiles every
`SKILL.md` into Codex CLI prompts, Cursor commands, and one `AGENTS.md` digest.
It's produced by `generate-adapters.mjs`, not hand-edited — after adding or
editing a skill, run `node generate-adapters.mjs` to regenerate it, then
`node verify-adapters.mjs` to confirm nothing drifted. See
`generated/README.md` for what's in there and how to install it into Codex/Cursor.

Every skill lands in one of two output buckets, `generated/portable/` or
`generated/claude-only/`, based on a curated `CLAUDE_ONLY` set at the top of
`generate-adapters.mjs`:

- **`portable/`** — no dependency on Claude Code/claude.ai-specific tooling;
  works as-is in Codex, Cursor, or any other agent.
- **`claude-only/`** — hard-depends on Claude Code tools (Agent/Task/Workflow,
  named `subagent_type`s), `mcp__claude_ai_*`/`mcp__chrome-devtools__*` MCP
  tools, or the Dia Browser + `agent-browser` + CDP setup.

A new skill that spawns subagents, calls an `mcp__claude_ai_*`/
`mcp__chrome-devtools__*` tool, or drives Dia/`agent-browser` belongs in
`CLAUDE_ONLY`; everything else is portable by default and needs no entry. The
generator also runs a token-based safety net on every skill body — it warns
(to stderr, without failing generation) when a skill contains a tell-tale
Claude-only token but isn't in `CLAUDE_ONLY`, or vice versa — so a
classification that's gone stale gets flagged instead of silently drifting.
`AGENTS.md` mirrors the split as two labeled sections.

## Editing an existing skill

Same idea, smaller surface. Editing a skill's prompt means editing **both** `skills/<name>/SKILL.md` **and** its mirrored copy in `docs/claude-ai-skill-reference.md`. If you touch `skills/help/SKILL.md`, mirror it into `skill-reference.md` too (trap #1). Renaming a skill touches all eight surfaces plus the folder name.

## Style

These are real working commands, not demos. Keep them:

- **Specific over generic** — name actual tools, paths, and failure modes, the way the existing skills do.
- **Action-first** — a numbered `## Steps` spine the model can follow, not prose.
- **Honest about scope** — in `## Notes`, say when *another* skill is the better tool.

If you're adapting one of Andrew's personal commands, strip anything tied to a private setup (specific index paths, named private agents, personal-voice references) and keep the software-project framing — that's the line this repo holds.
