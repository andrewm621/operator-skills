# Maestro — Cross-Provider Orchestration Spec

**Status:** Draft v0.1 · **Date:** 2026-08-28 · **Owner:** Andrew Miller

Maestro is a persistent, cross-provider, cross-terminal orchestration layer over a
fleet of AI coding agents. It is the maturation of `/orchestrate` from a one-shot,
single-session conductor into a standing command deck: tasks, todos, and git
worktrees that survive session boundaries and can be handed to **any** agent —
Claude Code, Codex, Cursor, or Grok Build.

---

## 1. The core problem

No two agents share a brain. Claude Code's `TodoWrite`, Codex's task list, Cursor's
composer, Grok Build's context — all private, per-session, per-provider. The moment
you open a second terminal or a second provider, coordination collapses to a human
holding it in their head.

**The only substrate every one of these tools speaks natively is the filesystem and
git.** No shared API, no shared memory, no shared MCP. So the coordination layer must
*be* files + git — anything else excludes half the fleet. That constraint is the whole
design.

---

## 2. Architecture — hybrid derived-index board

Two tiers. **Per-repo detail is authoritative; the global board is a derived
projection.** Never hand-edit the global view — `/maestro sync` rebuilds it from the
per-repo task files. One writer per fact; the two-writers problem never arises.

```
~/Projects/.maestro/               # GLOBAL — control plane (DERIVED, do not hand-edit)
  board.md                         # aggregated human dashboard, all repos
  index.jsonl                      # one line per task: id·repo·status·owner·updated
  registry.yaml                    # which repos participate + their absolute paths

<repo>/.maestro/                   # PER-REPO — AUTHORITATIVE detail
  tasks/T-014-auth.md              # full task: frontmatter + goal + context + acceptance
  todos/T-014.todos.md             # granular checklist for that task
  locks/T-014.claim.json           # current owner + heartbeat (concurrency control)
```

**Why markdown+frontmatter over SQLite:** it is git-diffable (you *see* who changed
what in history), human-editable mid-flight in any editor, and every LLM parses it
zero-shot with no client library. The board's readability *is* the feature.

### Worktrees live outside the repo tree

Task worktrees are created as siblings, never inside the repo, to avoid nesting a git
worktree inside its own working copy:

```
~/Projects/.maestro/worktrees/<repo>/T-014/    # git worktree, branch maestro/T-014-auth
```

---

## 3. The three boundaries

| Boundary | Enforced by | Prevents |
|----------|-------------|----------|
| **Isolation** | git worktree per task (`maestro/T-*` branch) | Parallel agents clobbering each other's files |
| **Concurrency** | claim file with agent id + heartbeat | Two sessions grabbing the same task |
| **Visibility** | derived `board.md` | Losing the cross-fleet picture across terminals |

---

## 4. Data schemas

### 4.1 Task file — `<repo>/.maestro/tasks/T-<id>-<slug>.md`

Authoritative. Human- and machine-editable. Frontmatter is the contract; the body is
the brief that gets projected into each worktree's `PROMPT.md` on route.

```yaml
---
id: T-014                          # unique within the repo; globally namespaced as <repo>/T-014
title: Refactor auth to Neon Auth
status: open                       # open | claimed | in-progress | review | blocked | done
owner: null                        # provider@session once claimed, e.g. codex@term-2
provider_hint: codex               # suggested best-fit provider (advisory, not binding)
worktree: null                     # abs path once spun, else null
branch: null                       # maestro/T-014-auth once spun
issue: null                        # optional external link, e.g. gh#231 (Codex handoff)
depends_on: []                     # [T-011] — blockers by id
priority: 2                        # 1 (now) .. 4 (someday)
created: 2026-08-28T09:00
updated: 2026-08-28T09:00
---

## Goal
One paragraph: the true intent, not the surface ask.

## Context pointers        ← the "read this first" that saves every cold session
- repo: liberty networking (read its CLAUDE.md first)
- touch: src/auth/**, proxy.ts
- prior art: dev-notes/decisions/2026-08-01-neon-auth.md

## Acceptance
- [ ] Bulleted, checkable definition of done
- [ ] Build + type-check pass
```

### 4.2 Todos file — `<repo>/.maestro/todos/T-<id>.todos.md`

The granular, in-flight checklist owned by whichever agent holds the claim. This is
the layer that maps to each provider's native todo mechanism — the agent works its
own list, then writes progress back here so the board reflects it across sessions.

```markdown
# T-014 todos — owner: codex@term-2 — updated: 2026-08-28T14:02
- [x] Map current Supabase auth call sites
- [ ] Swap session helper to Neon Auth        ← in progress
- [ ] Update proxy.ts guard
- [ ] Migrate tests
```

Convention: one `- [ ]` / `- [x]` per line. A trailing `← in progress` marker on at
most one line signals the active item. `/maestro sync` counts these for board
progress (`3/12`).

### 4.3 Claim / lock file — `<repo>/.maestro/locks/T-<id>.claim.json`

Presence = the task is owned. Concurrency control for a single human's machine (not a
distributed lock — no Paxos here, just a courteous heartbeat).

```json
{
  "task": "T-014",
  "owner": "codex@term-2",
  "provider": "codex",
  "pid": 48213,
  "claimed_at": "2026-08-28T13:40:00Z",
  "heartbeat": "2026-08-28T14:02:11Z",
  "ttl_seconds": 1800
}
```

**Stale-claim rule:** if `now - heartbeat > ttl_seconds`, the claim is stale — the
agent likely died. `/maestro sync` flags it; `/maestro claim --steal T-014` reclaims
it. Heartbeat is refreshed by the worker on each todo update (cheap, event-driven —
no daemon).

### 4.4 Global index — `~/Projects/.maestro/index.jsonl`

Derived cache. One JSON object per line (append-friendly, greppable, never
hand-edited). Rebuilt wholesale by `/maestro sync`.

```jsonl
{"id":"liberty/T-014","repo":"liberty networking","title":"Refactor auth to Neon Auth","status":"claimed","owner":"codex@term-2","progress":"3/12","priority":2,"updated":"2026-08-28T14:02"}
{"id":"agencyos/T-021","repo":"agencyos","title":"Stripe webhook retries","status":"open","owner":null,"progress":"0/0","priority":1,"updated":"2026-08-28T11:10"}
```

### 4.5 Registry — `~/Projects/.maestro/registry.yaml`

The opt-in list of repos Maestro scans. Keeps sync bounded to participating projects
instead of walking all 50+.

```yaml
repos:
  - name: liberty networking
    path: /Users/andrewmiller/Projects/liberty networking
  - name: agencyos
    path: /Users/andrewmiller/Projects/agencyos
id_prefix_from: name        # global ids namespaced by repo name
```

---

## 5. Task lifecycle (state machine)

```
        /orchestrate or /maestro new
                    │
                    ▼
   ┌─────┐ claim  ┌─────────┐ work starts ┌──────────────┐
   │ open├───────▶│ claimed ├────────────▶│ in-progress  │
   └─────┘        └─────────┘             └──────┬───────┘
      ▲                                          │ todos done
      │ steal (stale) / release                  ▼
      │                                     ┌──────────┐  merge & close  ┌──────┐
      └─────────────────────────────────── │  review  ├────────────────▶│ done │
                                            └──────────┘                 └──────┘
                          blocked ◀── any state (with reason) ──▶ back to prior
```

- **open → claimed:** a worker writes the claim file (atomic create; if it exists, the
  task is taken).
- **claimed → in-progress:** worktree spun, `PROMPT.md` seeded, agent launched.
- **in-progress → review:** all acceptance boxes checked; branch pushed / diff ready.
- **review → done:** merged to main, worktree torn down, branch deleted.
- **→ blocked:** any state, with a `blocked_reason`; surfaces on the board.

---

## 6. Neutral seed protocol (the provider-agnostic core)

The research payoff: **all four providers converge on the same three primitives** — a
headless `-p` prompt flag, a folder/worktree targeting flag, and native `AGENTS.md`
ingestion. So the seed is identical for every provider; only the launch string differs.

On `/maestro route T-<id> <provider>`, write into the worktree root:

1. **`PROMPT.md`** — projected from the task file's Goal + Context pointers + Acceptance +
   a pointer to the todos file. This is the vendor-neutral brief.
2. **`AGENTS.md`** stub — `"Read PROMPT.md for the current task. Follow this repo's
   CLAUDE.md for conventions."` Every provider reads `AGENTS.md` from the worktree root
   natively, so this guarantees pickup even if a future build stops accepting a long
   brief as a CLI arg.

**Pass the brief via stdin, not as a quoted arg** — long briefs blow past
argument-length limits. `cat PROMPT.md | <bin> -p ...`.

---

## 7. Provider adapter table

The adapter is a lookup table, not per-provider code. Only the binary name and flag
spelling vary.

| Provider | bin | folder/worktree flag | headless prompt | force / notes |
|----------|-----|----------------------|-----------------|---------------|
| **Claude Code** | `claude` | `cd <worktree>` | `/maestro work T-014` (native skill) | — |
| **Codex** | `codex` | `cd <worktree>` | via `/handoff` → GitHub issue #, then `codex` cites it | already owned adapter |
| **Cursor** | `agent`¹ | `--workspace <path>` | `cat PROMPT.md \| agent -p …` | `--force`, `--output-format json` |
| **Grok Build** | `grok` | `--cwd <path>` / `-w` (worktree) | `cat PROMPT.md \| grok -p …` | `--no-auto-update` (CI-safe) |

¹ Cursor's **headless** binary is `agent` (aka `cursor-agent`) — **not** the `cursor`
editor shim. Common trap.

### Adapter record shape

```yaml
codex:   { bin: codex, folder_flag: null, prompt_mode: issue,  seed: [PROMPT.md, AGENTS.md] }
cursor:  { bin: agent, folder_flag: "--workspace", prompt_flag: "-p", force_flag: "--force" }
grok:    { bin: grok,  folder_flag: "--cwd",       prompt_flag: "-p", force_flag: "--no-auto-update" }
claude:  { bin: claude, folder_flag: null, prompt_mode: native_skill }
```

### Example launch strings

```bash
# Cursor
cd ~/Projects/.maestro/worktrees/liberty/T-014 && cat PROMPT.md | agent -p "Execute the attached task brief" --force --output-format json

# Grok Build
cd ~/Projects/.maestro/worktrees/liberty/T-014 && cat PROMPT.md | grok -p "Execute the attached task brief" --cwd . --no-auto-update

# Claude Code
cd ~/Projects/.maestro/worktrees/liberty/T-014 && claude   # then: /maestro work T-014

# Codex
/handoff T-014   # → GitHub issue #; then `codex` in the worktree referencing the issue
```

**v1 dispatch is human-in-the-loop:** `/maestro route` prepares the worktree + seed and
*prints* the launch string. Andrew opens the terminal/provider and runs it. No
unattended cross-provider process spawning in v1 — get the substrate proven first.

---

## 8. Skill contracts

Two skills. `/orchestrate` evolves into the **planning front door**; `/maestro` is the
**standing command deck** (subcommands parsed from args).

### 8.1 `/orchestrate "<goal>"` — evolved

**Change in one line:** it stops being a verb that *runs* and becomes a verb that
*seeds*. Its old inline fan-out still works for quick jobs, but the decomposition now
lands on the durable Maestro board any provider/terminal can pick up.

| | Today | Evolved |
|---|-------|---------|
| Decompose goal | ✅ | ✅ (unchanged) |
| Decide shape (fan-out / pipeline / Workflow) | ✅ | ✅ (unchanged) |
| Route to specialist | ✅ inline agents | ✅ **+ can persist each task to the board** |
| Persistence | ❌ dies with session | ✅ writes `T-*` task files |
| Cross-provider | ❌ Claude only | ✅ tasks carry `provider_hint` |

New final step appended to the existing skill: **"If the goal is a standing effort
(spans sessions, or you want to hand pieces to other providers), persist the
decomposition to the Maestro board via `/maestro new` for each task instead of (or in
addition to) spawning inline. Print the resulting board."** Quick one-shot jobs behave
exactly as before — no regression.

### 8.2 `/maestro [subcommand]` — the command deck

| Invocation | Does |
|------------|------|
| `/maestro` | Render `board.md` — the cross-fleet dashboard (runs a sync first) |
| `/maestro new "<title>" [--repo R] [--provider P] [--after T-x]` | Create a task file in the repo's `.maestro/tasks/`, status `open` |
| `/maestro claim T-<id> [--steal]` | Write the claim file (atomic). `--steal` overrides a stale claim |
| `/maestro work [T-<id>]` | **Worker.** Claim → spin worktree + branch → seed `PROMPT.md`/`AGENTS.md` → load context pointers + todos into this session → set `in-progress` → start. No id = pick highest-priority open task in this repo |
| `/maestro route T-<id> <provider>` | Prepare worktree + seed, then print the provider launch string (§7). For `codex`, wraps `/handoff` |
| `/maestro sync` | Reconcile: walk registry repos, read `.maestro/tasks/*` + todos + claims + git worktree state, rebuild `index.jsonl` + `board.md`, flag stale claims and merge-ready tasks |
| `/maestro done T-<id>` | Verify acceptance checked → merge branch → tear down worktree → status `done` |
| `/maestro block T-<id> "<reason>"` | Set `blocked` + reason; surfaces on board |
| `/maestro release T-<id>` | Drop the claim, return to `open` (keeps worktree) |

**Worker (`/maestro work`) is the load-bearing skill** — it runs in each terminal/
provider and is what turns a board row into active work. It must:
1. Claim atomically (fail loud if already owned by a live session).
2. Create the worktree + `maestro/T-*` branch as a sibling (never nested).
3. Project `PROMPT.md` from the task file; write the `AGENTS.md` stub.
4. Read the task's **context pointers** and the repo `CLAUDE.md` before doing anything.
5. Work the todos file, refreshing the claim heartbeat on each update.
6. On completion, push branch / prep diff and flip to `review`.

### 8.3 Six-surface registration

Per `operator-skills/CONTRIBUTING.md`, each new/edited skill registers across six
surfaces, and `docs/claude-ai-skill-reference.md` mirrors skill bodies verbatim. Both
`/orchestrate` (edit) and `/maestro` (new) must run the contributor checklist + verify
script before landing.

---

## 9. Concurrency & failure model

- **Atomic claim:** create `locks/T-*.claim.json` with `O_EXCL` semantics (fail if
  exists). Losing the race = the task is taken; pick another.
- **Heartbeat, not daemon:** the worker rewrites `heartbeat` on each todo update. No
  background process. If the session dies, the heartbeat goes stale.
- **Stale reclaim:** `now - heartbeat > ttl_seconds` → `/maestro sync` marks the claim
  stale on the board; `--steal` reclaims.
- **Merge conflicts:** each task on its own branch/worktree, so conflicts surface only
  at `/maestro done` merge time — normal git, reviewed by a human or `reviewer` agent.
- **No cross-machine sync in v1.** Single human, single machine, multiple terminals/
  providers. Distributed coordination is explicitly out of scope.

---

## 10. Build plan (phased)

**Phase 0 — substrate, single-player.** File formats + `/maestro` (board/new/claim) +
`/maestro sync` + worktree wiring via `EnterWorktree`. Prove it solo: create tasks,
claim, spin worktrees, watch the board update. *If this isn't satisfying solo, adding
providers won't save it.*

**Phase 1 — the two solid adapters.** `/maestro work` (Claude worker) + Codex route
(wrap `/handoff`). Real 2-provider parallelism. Evolve `/orchestrate` to seed the board.

**Phase 2 — Cursor + Grok adapters.** Add the two CLI adapters. Gate on the flag
verification in §11.

**Phase 3 (later, not v1) — automation.** Same-provider auto-claim, a git-hook or
`/loop`-driven `sync`, richer board rendering. Only after the substrate is trusted.

---

## 11. Open unknowns — verify at build time (`--help`, not docs)

These are implementation trivia, not design blockers, but confirm before hardcoding:

1. **Cursor `agent` folder flag** — docs show `--workspace <path>` in one place, not
   corroborated in the CLI overview. Verify with `agent --help`.
   **RESOLVED 2026-08-29**, via `cursor-agent --help` (not `agent --help` — see item 2):
   `--workspace <path>` confirmed exactly as documented ("Workspace directory to use,
   defaults to current working directory"). `route`'s printed launch string doesn't
   actually need it, though — `cd`ing into the worktree first already sets the default,
   same as the `claude`/`codex` rows.
2. **Cursor editor vs agent shim** — bare `cursor <folder>` had a mid-2026 regression
   routing to agent-chat; `cursor -n` / `cursor editor` forced GUI. Irrelevant to the
   headless path but note it so we don't grab the wrong binary.
   **RESOLVED 2026-08-29 — and it's worse than the doc-trap this item anticipated.**
   §7's footnote already said the headless binary is "`agent` (aka `cursor-agent`)."
   On a machine with Grok Build also installed, bare `agent` on `PATH` doesn't
   ambiguously mean "the GUI shim" — it can resolve to **Grok Build's own CLI**,
   confirmed live: `agent --help` here prints `Grok Build TUI` and Grok's usage banner,
   because Grok Build ships its own `agent` binary at `~/.grok/bin/agent`. The real
   Cursor headless binary, confirmed present and correct via its own `--help`, is
   `cursor-agent` — that's now the adapter table's `bin` for `cursor`, not `agent`.
   Never use bare `agent` as the Cursor bin name; the collision is real, not
   hypothetical.
3. **Cursor arg-length** — confirm a realistically long `PROMPT.md` survives; prefer
   stdin piping (already the plan). **Still open** — not verified against a real
   headless run (out of scope for a `--help`-only pass); the launch string still pipes
   `PROMPT.md` via stdin rather than passing it as an arg, so the risk this item
   flagged is mitigated by design either way.
4. **Cursor `.cursor/rules` on headless** — confirm the headless `agent` reads
   `.cursor/rules/*.mdc` the same as the GUI (docs conflate CLI/editor parity).
   **Still open** — not verified; would require a real run.
5. **Grok `--cwd` + `-w` interaction** — does `--cwd` set source repo and `-w` create a
   worktree relative to it, or are they mutually exclusive? Verify with `grok --help`.
   **RESOLVED 2026-08-29**, via `grok --help`: `-w`/`--worktree` is documented as
   inert in single-turn mode — "Headless (`-p`) does not create a worktree from this
   flag." So there's no `--cwd`/`-w` interaction to worry about in the launch string
   at all: `route` uses `--cwd .` alone, pointed at the worktree Maestro already
   seeded, and `-w` is simply never passed.
6. **Grok OSS vs hosted build** — xAI open-sourced Grok Build July 2026; flag
   names/behavior may differ between the hosted-inference and self-hosted builds. Run
   `grok inspect` in a seeded worktree to confirm `AGENTS.md` pickup before trusting a run.
   **Partially resolved.** The build-drift risk this item warned about is real and
   confirmed: the researched `force_flag` (`--no-auto-update`) does **not** appear
   anywhere in `grok --help` on this (self-hosted) build — it was dropped from the
   adapter table and replaced with the confirmed `--always-approve`. The `grok inspect`
   / `AGENTS.md`-pickup half of this item is still **open** — not run, since that
   would mean seeding a real task and isn't a plain `--help` read.
7. **Grok flag spellings** (`--single` vs `-p`, `--json-schema`) — single third-party
   source; verify against `grok --help`.
   **RESOLVED 2026-08-29**, via `grok --help`: both spellings coexist —
   `-p, --single <PROMPT>` ("Single-turn prompt. Prints the response to stdout and
   exits"), `-p` is the short alias. `--json-schema <SCHEMA>` also confirmed present,
   unrelated to prompt delivery. Route's launch string uses `-p` with the brief text
   as its value, matching this exactly.

---

## 12. Naming & lineage

- **System / directory:** Maestro · `.maestro/`
- **Command deck:** `/maestro [subcommand]`
- **Planning front door:** `/orchestrate "<goal>"` (evolved, backward-compatible)

The metaphor matures from *orchestrate* ("conduct one performance") to *Maestro* ("the
conductor who runs the whole ensemble, all night, across every stage"). Same lineage,
bigger reach.
