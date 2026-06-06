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

A skill is registered in **six surfaces**. Update all of them — miss one and it drifts silently (no error, no warning).

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

## Two traps

These are the two things that have actually bitten this repo.

**1. `docs/claude-ai-skill-reference.md` is a verbatim mirror of the skill files.** The Claude.ai web client can't read the `skills/` folder, so every `SKILL.md` is flattened into this one uploadable Knowledge file. That means **editing any skill requires editing its copy here too**, or the web version diverges from the real one. The subtle case: the `/help` skill (its catalog + quick combos) lives *inside* this mirror — so a `/help` edit must be duplicated in `skill-reference.md`, or the two `/help`s drift.

**2. There are two different skill counts, and they are not the same number.** `README.md`'s count is the number of folders in `skills/`. The `/help` cheat sheet keeps its **own** count on a different basis (it omits some skills and includes `@rebel/ui` skills that aren't in the README catalog). Don't "fix" one to match the other — bump each within its own world.

## Verify before committing

```bash
# 1. folder count matches the README claim
ls -d skills/*/ | wc -l

# 2. no stale counts left behind (the only legit "3x" matches are a Notion ID + hex colors)
grep -rn "all 3[0-9] skill\|3[0-9] custom\|3[0-9] operator" README.md docs/

# 3. the /help cheat sheet matches its mirror exactly
awk '/^ SKILL CATALOG/{f=1} f{print} /Cross-project/{if(f)exit}' skills/help/SKILL.md > /tmp/a
awk '/^ SKILL CATALOG/{f=1} f{print} /Cross-project/{if(f)exit}' docs/claude-ai-skill-reference.md > /tmp/b
diff /tmp/a /tmp/b && echo "IDENTICAL"

# 4. try it live
ln -sf "$PWD/skills" ~/.claude/skills/operator   # if not already linked
# open a new Claude Code session and type /<name>
```

## Editing an existing skill

Same idea, smaller surface. Editing a skill's prompt means editing **both** `skills/<name>/SKILL.md` **and** its mirrored copy in `docs/claude-ai-skill-reference.md`. If you touch `skills/help/SKILL.md`, mirror it into `skill-reference.md` too (trap #1). Renaming a skill touches all six surfaces plus the folder name.

## Style

These are real working commands, not demos. Keep them:

- **Specific over generic** — name actual tools, paths, and failure modes, the way the existing skills do.
- **Action-first** — a numbered `## Steps` spine the model can follow, not prose.
- **Honest about scope** — in `## Notes`, say when *another* skill is the better tool.

If you're adapting one of Andrew's personal commands, strip anything tied to a private setup (specific index paths, named private agents, personal-voice references) and keep the software-project framing — that's the line this repo holds.
