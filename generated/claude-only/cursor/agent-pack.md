# agent-pack

Give a repo the standard agent context pack, check whether it has gone stale, or update it at the end of a session.

Arguments: {the text you type after the command}

**Config:** optional `knowledge` (your vault, used to find a project note for STATUS and decisions) from `~/.config/operator-skills/config.yaml`. See `docs/config.md`. Without it the skill uses the repo alone.

## Modes

- `/agent-pack [path]`: build the pack, or update it if it exists. Default path: the current repo root (`git rev-parse --show-toplevel`).
- `/agent-pack check [path]`: report freshness only. Writes nothing.
- `/agent-pack close [path]`: end of a session. Update `STATUS.md`, add decision records for decisions made this session, add new gotchas to `AGENTS.md`. Touches nothing else.

## The pack

| File | Answers | Template |
|---|---|---|
| `AGENTS.md` | How to run, test, deploy. What never to touch. Gotchas. | `templates/AGENTS.md` |
| `CLAUDE.md` | Symlink to `AGENTS.md`, so every agent reads one file | n/a |
| `ARCHITECTURE.md` | Modules, data flow, external services, **where to change X** | `templates/ARCHITECTURE.md` |
| `STATUS.md` | What's live, in flight, next, last verified | `templates/STATUS.md` |
| `decisions/NNNN-slug.md` | Why X, and what X replaced | `templates/decision.md` |
| `GLOSSARY.md` (only if the domain has its own terms) | What the project's nouns mean | `templates/GLOSSARY.md` |

Templates live next to this file in `templates/`. Read them before writing.

## Hard rules

1. **Never overwrite what a person wrote.** Generated content goes between markers: `<!-- agent-pack:begin <section> -->` … `<!-- agent-pack:end <section> -->`. A file that doesn't exist yet gets the full template. On update, rewrite only inside markers. If a file exists without markers, add only the sections it doesn't already cover under any heading (skip `about` when it has an intro; link an existing routing table rather than adding a second one), at the end and inside markers, and list anything you think is wrong as a suggestion in your report. Don't edit its text.
2. **Stamp once per file.** The first managed section of each file starts with `<!-- agent-pack: <YYYY-MM-DD> @ <short sha> -->`. Update the stamp whenever you rewrite any section in that file. Decision records have no markers and no stamp. Get both values from the shell (`date +%F`, `git rev-parse --short HEAD`), never by hand.
3. **Only write commands you found.** Each command in `AGENTS.md` must come from `package.json` scripts, a Makefile, a script file, a README or the existing docs. Read every script before you classify it, and check its default target: a script that looks local can default to production. Mark each command with one status: `(ran ok YYYY-MM-DD)`, `(not run)`, `(not run: production)` for anything that writes to or calls a live system, `(not run: live by default)` for a dev command whose default config points at real data, or `(not run: network)` for anything that calls a remote non-production service. Also flag build steps with side effects: copying secrets into output, overwriting a deploy artifact, rewriting committed files. Run only read-only or local commands (typecheck, lint, unit tests, a local build). **Never** deploy, migrate, upload, send email, or touch production data, even if a script is right there.
4. **No secrets, no client data.** Never copy into the pack: keys, tokens, access codes, passwords, `.env` values, the names of people (client staff, end users, the owner, including people named in example commands, file paths and GitHub handles in remote URLs: give the remote as name and host only), and use roles in owner fields ("repo owner", "client"), emails other than role addresses on the project's own domain, phone numbers, VINs, bank or customer account numbers, per-customer amounts. Infrastructure IDs that are already in tracked config (cloud account IDs, namespace IDs) get referenced by file name, not copied. Name the file where a secret lives (`.access`, `.dev.vars`) and never its contents. Describe data by shape ("one row per vehicle per snapshot day"), not by example rows. For a client project, name the client organization only.
5. **Short beats complete.** Managed content stays under ~150 lines in `AGENTS.md`, ~250 in `ARCHITECTURE.md`, ~60 in `STATUS.md`. If a section wants more, link to the file that holds it. If a human-written file is already over its cap, append only what's missing and report its length with a split suggestion.
6. **Don't commit.** Leave the changes in the working tree and list them. Commit only if the user asks, and run `git branch --show-current` first.

## Build / update steps

1. **Resolve the repo.** Write to the path the user gave, even if `git rev-parse` reports it differently (case, symlinks). Read whatever already exists: `AGENTS.md`, `CLAUDE.md`, `README*`, `ARCHITECTURE.md`, `STATUS.md`, `docs/`, `decisions/` or `docs/adr/`. Note which files are real and which are symlinks. Record backup state from the last fetch (don't fetch unless allowed; say "per last fetch"): is there a remote, is HEAD pushed (`git status -sb`), and how far is the branch behind the default branch (`git rev-list --count HEAD..origin/<default>`)? No remote, or a branch far behind, goes first in STATUS Next. List nested `.git` folders and worktrees (`.claude/worktrees`, `.delta/`) and exclude them from every search.
2. **Pair CLAUDE.md and AGENTS.md.** This skill's rules, which are looser than `/map`'s:
   - Neither exists → create `AGENTS.md` and symlink `CLAUDE.md` to it. No need to ask.
   - Only `AGENTS.md` exists → add the symlink. No need to ask.
   - Only `CLAUDE.md` exists as a real file → ask first, then `mv CLAUDE.md AGENTS.md && ln -s AGENTS.md CLAUDE.md`. If the user says no, or you can't ask (you're a subagent), append to `CLAUDE.md` under a `## Agent pack` heading and recommend the move.
   - Both exist as real files → don't merge. Flag it and write only into `AGENTS.md`.
   - `CLAUDE.md` is a symlink to somewhere else, imports `@AGENTS.md`, or is a short stub pointing to `AGENTS.md` in prose → leave it (recommend the symlink for a stub).
3. **Explore.** If the repo has more than ~50 non-test source files across all code folders, hand this to an Explore subagent. Pass it the never-open-secrets list, and ask for: stack and versions, entry points, routes/handlers/tools, data stores and schema files, external services and how each is called, config files (`wrangler.toml`, `drizzle.config.*`, `vite.config.*`), scripts and what each one's default target is, test files per route group or area, deploy path, `.gitignore`d files that matter (secrets, data). Also read `git log --oneline -30` and `git log -5 --stat` to see what's moving.
4. **Write ARCHITECTURE.md** from the template. Mandatory: a one-paragraph overview, a Mermaid diagram of the request or data flow, a module table, and the **where to change X** table. Build that table from real seams in the code (each route group, tool, schema area, job, page) and phrase each row as a task someone would actually ask for. Each row names the files, the tests that cover it (or "none"), and the trap if there is one. Put each path in its own backticks, relative to the repo root (`src/x.ts`, not "`fn()` in src/x.ts"), so step 9 can check them. Aim for 8–20 rows.
5. **Write AGENTS.md** from the template: what this is (2–3 lines), setup, commands (rule 3), deploy (described, never run), conventions, **never do**, gotchas, pointers to the other pack files. Pull gotchas from code comments (`HACK`, `NOTE`, `XXX`, `careful`), README warnings, commit messages with "fix" in them, and the existing docs.
6. **Write STATUS.md** from the template, using recent commits, open TODOs, the README, and the project's note in your knowledge vault if you have one (search `knowledge.vaults.<default>.path` for the repo name; skip this if `knowledge` isn't configured; if there's no note, say "no vault note" in the report). Anything you inferred and couldn't confirm gets an `(inferred)` tag.
7. **Decisions.** Don't make up history. If the repo has no decisions folder, create `decisions/` and copy `templates/decision.md` in as `decisions/TEMPLATE.md`. Add a record only for a decision stated plainly in the repo's docs, its commits, or the vault project home ("switched from X to Y because…"). Each record names its source. Number them `0001-…`.
8. **Glossary.** Only if the code or docs use terms an outsider would misread. Five good entries beat thirty obvious ones.
9. **Self-check before reporting.**
   Run these in `bash`, not zsh (zsh doesn't word-split a file list in a variable, so the greps quietly match nothing). Scan only what you added: new files in full, plus `git diff -U0 | grep '^+'` for existing files.
   - Secret-shaped strings: `grep -E 'sk-[A-Za-z0-9]{16}|AKIA[0-9A-Z]{16}|ghp_|-----BEGIN|\b[0-9a-fA-F]{24,}\b|[A-Za-z0-9+=]{40,}'` (the base64 run excludes `/` so paths don't match), plus email addresses. Role addresses on the project's own domain may stay. Report them, don't strip them.
   - Build a deny-list of every person's name and handle you came across this session (README, docs, vault notes, comments, fixtures) and grep for each one.
   - Fix anything you find, then confirm each backticked path in the **Edit** and **Tests** columns of the "where to change" table exists, from the repo root (`test -e`, or `compgen -G` for a glob).
   - Delete any temp files you made that hold names or data.
10. **Report:** the files created or changed, which commands ran and their results, what you inferred, suggestions for human-written sections, and anything that looked risky.

## Check mode

Writes nothing. For each pack file, report whether it exists, its stamp date and sha, and `git rev-list --count <sha>..HEAD -- . ':!*.md'` (commits since the stamp that touched non-markdown files). Mark the pack **stale** if any file's stamp is more than 20 such commits behind, or `STATUS.md` hasn't changed in 14 days while code has. Also confirm each path in the "where to change" table still exists. End with one line: `fresh`, `stale: <why>`, or `missing: <files>`.

## Close mode

Run at the end of a working session, in the repo where the work happened.

1. Read `STATUS.md`, then work out what changed this session: `git log` since the session started (or since `STATUS.md` last changed), `git status`, and what the conversation decided.
2. Rewrite the managed parts of `STATUS.md`: Live, In flight, Next (1–3 steps, most important first), Last verified (only what was actually checked this session, with the command or URL used), Open questions.
3. For each real decision made this session, add `decisions/NNNN-slug.md`: decision, because, replaces, date. Skip if there were none.
4. Append any new gotcha to the `AGENTS.md` gotchas section, one line each.
5. If code changed enough that a "where to change" row is now wrong, fix that row only. Point out a full rebuild if more than a few rows look wrong.
6. Report what changed. Don't commit unless asked.
