# maestro

Maestro is the standing command deck for cross-provider, cross-session orchestration — tasks, claims, worktrees, and a derived board that live in the filesystem (not a chat session), so any terminal or provider (Claude Code, Codex, Cursor, Grok Build) can pick up a task where another left off. Where `/orchestrate` decomposes and runs a goal inline in one session, `/maestro` is the durable substrate underneath it — and once a goal is a standing effort, `/orchestrate` seeds tasks onto this board instead of (or alongside) spawning inline.

Arguments: {the text you type after the command}

**Current scope: `board` (default), `new`, `claim`, `heartbeat`, `sync`, `work`, `route` — all four providers (`claude`, `codex`, `cursor`, `grok`) are wired in `route`.** `done`, `block`, and `release` aren't built yet; if `{the text you type after the command}` asks for one of those, say so plainly and point at `board`/`work`/`route` instead of improvising.

All state lives under `~/Projects/.maestro/` (global, derived — never hand-edited, includes `worktrees/`) and `<repo>/.maestro/` (per-repo, authoritative). Full schema in this repo's `docs/maestro-spec.md`. Every subcommand below is a thin wrapper over `node maestro.mjs <subcommand> ...`, which lives right next to this file — resolve its path from where this SKILL.md was loaded (e.g. `~/.claude/skills/operator/maestro/maestro.mjs` under the standard symlink install).

## Steps

1. **Parse the subcommand** from `{the text you type after the command}` — the first token is the subcommand, everything after it is passed through verbatim (quoted title, `--flag value` pairs).

   | Input | Runs |
   |---|---|
   | (empty) or `board` | `node maestro.mjs board` |
   | `new "<title>" [--repo R] [--provider P] [--after T-x] [--priority N]` | `node maestro.mjs new "<title>" ...` |
   | `claim T-<id> [--repo R] [--owner O] [--steal]` | `node maestro.mjs claim T-<id> ...` |
   | `heartbeat T-<id> [--repo R]` | `node maestro.mjs heartbeat T-<id> ...` |
   | `sync` | `node maestro.mjs sync` |
   | `work [T-<id>]` | `node maestro.mjs work T-<id> ...`, then read + act on what it prints (step 6) |
   | `route T-<id> claude \| codex \| cursor \| grok` | `node maestro.mjs route T-<id> <provider> ...`, then act per step 7 |
   | `set T-<id> [--issue X] [--status S] ...` | Internal helper — `node maestro.mjs set T-<id> ...` (used by step 7, not usually invoked directly) |

2. **`board` (default)** — Run `node maestro.mjs board` (it syncs first, then prints `board.md`). Don't just paste the raw markdown back — read it and present it like a status report: lead with what's actionable (oldest open high-priority task, any `STALE` claim), then the grouped table. If a registered repo has zero tasks, don't belabor it.

3. **`new`** — Before running, sanity-check the title captures the true intent (same instinct as `/orchestrate` step 1 — the surface ask isn't always the real goal), and infer `--repo` from the current working directory if the user didn't name one and it's obvious. Run the command, then report the new `T-<id>` and where the task file landed.

4. **`claim`** — Run the command as given. If it fails with "owned by ... live", report that plainly and stop — don't retry with `--steal` on your own initiative; a live claim means another session or provider is actively on it. If it instead fails because the claim is **stale**, that's the one case where suggesting `--steal` is appropriate: say who the stale owner was and how long ago the heartbeat lapsed, then confirm (or, if the user's instruction already implied "take it regardless," proceed straight to `--steal`).

5. **`heartbeat` / `sync`** — Run directly, report the one-line result. `sync` is a full rebuild of the global board from per-repo task files — safe to run anytime; it never mutates task files themselves, only the derived `index.jsonl` and `board.md`.

6. **`work T-<id>`** — the load-bearing worker loop, and the one subcommand where "run it and report" isn't enough:
   1. Run `node maestro.mjs work T-<id> [--repo R]`. It claims the task, spins a sibling git worktree on branch `maestro/T-<id>-<slug>`, seeds `PROMPT.md` + `AGENTS.md` into it, seeds the todos file from the task's Acceptance boxes if empty, and flips status to `in-progress`. If it fails (not a git repo, branch/worktree already exists, or the claim is live elsewhere), it rolls the claim back to `open` before failing — report the error as-is, don't retry blind.
   2. **Read the printed `PROMPT.md`**, then the repo's own `CLAUDE.md` (or README), then the task's context pointers — in that order, before touching any code. A cold read of the brief without the repo's conventions is how you reinvent a pattern that already exists.
   3. Work the todos file (`<repo>/.maestro/todos/T-<id>.todos.md`) item by item — check boxes as you finish them, and run `node maestro.mjs heartbeat T-<id> --repo R` on each update so a `sync` elsewhere doesn't see this claim as stale mid-task.
   4. When every Acceptance box is checked and the build/type-check passes, flip status with `node maestro.mjs set T-<id> --repo R --status review` and say so — don't leave it silently `in-progress` once the work is actually done.

7. **`route T-<id> <provider>`** — hand a task to another provider instead of working it yourself. All four providers seed the same worktree + `PROMPT.md` + `AGENTS.md`; only the printed launch string differs (spec §7):
   1. Run `node maestro.mjs route T-<id> <provider> --repo R`. If the launch string's binary (`cursor-agent` for `cursor`, `grok` for `grok`) isn't on PATH, the CLI still prints the launch string — it prepends a `note:` advisory instead of blocking. Relay that note plainly if it appears; don't strip it.
   2. **`claude`**: present the printed launch string — Andrew opens the terminal and runs it himself (`/maestro work T-<id>` in the new session). v1 dispatch is human-in-the-loop by design (spec §7) — never spawn the other provider's process yourself.
   3. **`codex`**: after the CLI prints its two-step instructions, actually invoke `/handoff T-<id>` yourself to create the GitHub issue, then record the result with `node maestro.mjs set T-<id> --repo R --issue gh#<n>` so the task file and board reflect it. Only then present the final launch string — don't hand Andrew a string that references an issue that doesn't exist yet.
   4. **`cursor`**: the printed string pipes `PROMPT.md` via stdin into `cursor-agent -p "Execute the attached task brief" --force --output-format json` (headless print mode; brief piped rather than passed as an arg to avoid CLI length limits). Note the binary is `cursor-agent`, **not** bare `agent` — on a machine with Grok Build also installed, plain `agent` on PATH can resolve to Grok's own CLI instead. Just present the string; don't "fix" the binary name back to `agent`.
   5. **`grok`**: the printed string pipes `PROMPT.md` via stdin into `grok -p "Execute the attached task brief" --cwd . --always-approve`. `--cwd .` points grok at the worktree already seeded for it — never suggest grok's own `-w`/`--worktree` flag, which would create a second, nested worktree.

8. **Report** — Always surface the actual command output, or a faithful summary of it — never a paraphrase that hides an error. A non-zero exit is usually load-bearing here (e.g. "owned by X" is proof the atomic claim did its job, not a bug to smooth over).

## Notes
- `work` and `route` spin real git worktrees as siblings of the repo (`~/Projects/.maestro/worktrees/<repo>/T-<id>/`, never nested inside it) and seed the vendor-neutral `PROMPT.md`/`AGENTS.md` brief (spec §6). `done`/`block`/`release` — merge-and-teardown, blocking, and un-claiming — are still not built; don't hand-roll them.
- `/orchestrate` is the planning front door; once a goal is a standing, cross-session effort — or you want to hand pieces to another provider — persist the decomposition here via `maestro new "<title>" --repo R --provider <hint>` for each task, carrying the `provider_hint` you'd route to, then print the board.
- The registry (`~/Projects/.maestro/registry.yaml`) is hand-maintained — add a repo to it by appending a `- name` / `path` pair. Everything else under `~/Projects/.maestro/` (including `worktrees/`) is derived and safe to delete and regenerate — except don't delete a worktree by hand while it's in `git worktree list`; use `git worktree remove`.
- Never hand-edit `board.md` or `index.jsonl` — `sync` rebuilds both wholesale, so a manual edit is silently discarded on the next run. Per-repo `.maestro/tasks/*.md` and `.maestro/todos/*.md` are the real, editable source of truth.
- The `/handoff` skill referenced in step 7 is not part of this repo — it's assumed to already exist in the runtime environment (spec §7 calls the Codex adapter "already owned"). If it isn't available, say so rather than faking an issue number.
- `cursor`/`grok` launch strings are printed, never run automatically — v1 dispatch is entirely human-in-the-loop (spec §7). Some of their flags (Grok's non-interactive/approval flag in particular) are best-effort corrections from a real `--help` read, not a verified live run — flag that if Andrew hits a flag error running one himself, and update `maestro.mjs`'s `ADAPTERS` table rather than guessing again.
