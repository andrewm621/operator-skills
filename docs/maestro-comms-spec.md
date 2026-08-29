# Maestro Comms (L2) — agent-to-agent + agent-to-human messaging

**Status:** Draft v0.1 · **Date:** 2026-08-29 · **Owner:** Andrew Miller
**Builds on:** `docs/maestro-spec.md` (L1 coordination substrate)

The comms layer lets agents (any provider) and the human exchange messages tied to
the Maestro board — post progress, ask a blocking question, answer one, hand off
context — over the **same filesystem + git bus** as the board. No daemon, no socket,
no broker. It is the "agents talk to each other" layer, and it is valuable on its own
before any dashboard (L4) exists.

---

## 1. Design stance

- **Async by design.** An agent asking a question and a human (or another agent)
  answering minutes/hours later, from another terminal or machine, is an *async*
  problem. A file models it; a socket would force both ends online at once.
- **Same bus as L1.** Channels are append-only markdown files under `.maestro/`.
  Git-tracked, human-readable, inspectable, provider-agnostic. The channel file *is*
  the conversation — persistence, replay, and cross-provider reach come for free.
- **Provider-agnostic via the CLI.** Every provider gets messaging because it is just
  a CLI call the agent runs (`node maestro.mjs say …`). No per-provider integration.
- **What it does NOT do (scope guard):** no real-time push, no delivery/ordering
  guarantees beyond append order, no daemon. An offline agent reads the thread when it
  resumes — that lag is the feature, not a bug.

---

## 2. Directory layout

```
<repo>/.maestro/channels/
  T-014.md            # per-task thread — authoritative, co-located with the work
  T-021.md
~/Projects/.maestro/channels/
  fleet.md            # cross-task / cross-repo broadcasts (global, authoritative)
~/Projects/.maestro/
  inbox.jsonl         # DERIVED — open asks addressed to someone, rebuilt by `sync`
```

Per-task/fleet channels are **authoritative** (like task files). `inbox.jsonl` is a
**derived projection** rebuilt wholesale by `maestro sync` — never hand-edited (same
one-writer-per-fact rule as `board.md`/`index.jsonl`).

---

## 3. Message format

One message = one append-only line. Human-readable first, machine-parseable second.

```
- [2026-08-29T21:03Z] (M-014-1) claude@t1 · say: Blocked — need T-011 merged before I wire the guard.
- [2026-08-29T21:05Z] (M-021-7) codex@t2 · say: T-011 pushed, PR #232 — unblocked.
- [2026-08-29T21:06Z] (M-014-2) claude@t1 · ask→@andrew: Neon Auth or Clerk here? #open
- [2026-08-29T21:20Z] (M-014-3) andrew · answer→claude@t1 re:M-014-2: Neon Auth. #resolved
```

| Field | Meaning |
|-------|---------|
| `[ts]` | UTC ISO timestamp (append order is the only ordering guarantee) |
| `(M-<id>)` | Stable message id — `M-<taskid>-<seq>` (seq = next per channel). `fleet` uses `M-fleet-<seq>` |
| `author` | claim owner id (`claude@t1`, `codex@t2`) or `andrew` |
| `kind` | `say` (update), `ask` (needs an answer), `answer` (replies to an ask), `handoff` (context transfer) |
| `→@target` | Optional. `@andrew` = the human; `codex@t2` = a specific agent. Absent = broadcast to the thread |
| `re:M-…` | Optional. On `answer`, the ask it resolves |
| `#open` / `#resolved` | Lifecycle tag on `ask`/`answer` only. An `ask` starts `#open`; its `answer` flips it `#resolved` |

Parsing: split on `] `, `· `, `→`, `re:`, and the trailing `#tag`. Malformed lines are
skipped with a warning by `sync` (never crash the whole read) — same rule as tasks.

---

## 4. CLI verbs (extend `maestro.mjs`)

| Command | Does |
|---|---|
| `say <T-id\|fleet> "text" [--repo R]` | Append a `say` line; refresh the author's claim heartbeat |
| `ask <T-id\|fleet> "question" [--to who] [--repo R]` | Append an `ask` line tagged `#open`, target defaults to `@andrew`. Prints the new `M-id` |
| `answer <M-id> "text" [--repo R]` | Append an `answer` re: that ask, flip the ask's line to `#resolved`, target = the ask's author |
| `read <T-id\|fleet> [--since ts] [--repo R]` | Print the thread (or only messages after `ts`) |
| `inbox [--for who] [--json]` | List all `#open` asks addressed to `who` (default `andrew`) across every registry repo + fleet. **This is the "needs human" queue.** |

`board` (existing) gains a derived **⚑ NEEDS YOU (n)** header block counting open asks
addressed to `@andrew`, and `sync` writes a `needs_human` count per task into
`index.jsonl`.

### Answer/resolve lifecycle
An `ask` gets a stable `M-id`. `answer <M-id>` (a) appends the answer line targeted at
the ask's author and (b) rewrites the original ask line's `#open` → `#resolved` in
place (the one sanctioned in-place edit — it's a status flip on an owned line, mirroring
how `claim` flips task frontmatter). `inbox` shows only `#open`. The asking agent sees
the answer on its next `read`/heartbeat and continues.

---

## 5. Concurrency & safety

- **Append atomicity:** each message is a single `fs.appendFileSync` of one
  `\n`-terminated line, guarded by a short-lived per-channel `mkdir` lock
  (`channels/.T-014.lock/`) — same atomic primitive as claims — so two agents appending
  at once serialize instead of interleaving.
- **The one in-place edit** is the `#open`→`#resolved` flip on `answer`; it takes the
  same channel lock. Everything else is append-only.
- **No daemon.** `inbox`/`read` are pull-based; the L4 app polls/renders the files. An
  optional `--notify` on `ask` could ping (peon-ping) but stays out of the core.

---

## 6. Agent + human workflows

**Agent, blocked or needs a decision** (seeded via `PROMPT.md`/`AGENTS.md`):
> If you're blocked or need a decision you can't make, run
> `maestro ask T-<id> "…"` (add `--to <agent>` to ask a specific teammate), then either
> work another todo or stop and wait. Check `maestro read T-<id>` for answers before
> resuming.

**Agent→agent handoff:** `maestro handoff T-014 --to codex@t2 "context: X, Y; next: Z"`
— the target sees it via `inbox --for codex@t2` or `read T-014`. Enables real Q&A and
context transfer across providers, not just status broadcast.

**Human:** `maestro inbox` → see every open question across the fleet → `maestro answer
M-014-2 "Neon Auth"`. The answer lands in the thread; the asking agent picks it up. In
L4 this is the **⚑ NEEDS YOU** panel with an inline reply box.

---

## 7. Integration points

- **Board:** `sync` surfaces open-ask counts (per task + a fleet ⚑ header). A task
  blocked on an unanswered `ask→@andrew` is visibly "waiting on you," distinct from
  plain in-progress.
- **Phase 3 (automation):** dependency unblocking can auto-`say` to `fleet` ("T-011
  done → T-014 unblocked"); a reaped dead claim can auto-`say` to its task thread so the
  history explains the status change. Auto-`ask` stays human-gated.
- **L4 Control Tower:** renders `channels/*` as live threads and `inbox.jsonl` as the
  question queue; its only write-backs are `answer`, `say`, and dispatch (`route`) —
  all existing CLI verbs, so the app stays a thin viewer over the filesystem.

---

## 8. Build order

1. `say` + `read` + per-task channel files + the mkdir append-lock — the minimal
   "agents can post and read a thread" core.
2. `ask` + `answer` + `#open/#resolved` lifecycle + stable `M-ids`.
3. `inbox` + the derived `inbox.jsonl` + `board`'s ⚑ header (the human queue).
4. `handoff` + `--to` targeting + `fleet.md` broadcasts (agent↔agent + cross-task).

Ships as new subcommands on the existing `/maestro` skill — no new skill folder, so only
the verbatim-mirror + `generated/` regeneration cost (per `CONTRIBUTING.md`).

---

## 9. Open questions

- **Message id scheme** — `M-<taskid>-<seq>` is human-legible but requires reading the
  channel to compute the next seq (cheap; one file). A random short hash avoids the read
  but is opaque. Leaning seq for legibility.
- **`inbox` identity** — `--for` matches a claim owner id. If a session's owner id isn't
  stable across restarts, agent-targeted asks could be missed; may need a stable
  per-agent handle beyond `provider@session`.
- **Retention** — channels grow append-only forever. A `maestro archive <T-id>` on
  `done` (move the thread to `channels/archive/`) keeps live threads lean; deferred.
