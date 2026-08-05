Manage the local Slack directory that backs `/slack-reply`.

Arguments: $ARGUMENTS

## Data — one writer, one mirror

| File | Role |
|------|------|
| `~/.claude/projects/-Users-andrewmiller-knowledge/slack/registry.yaml` | **Source of truth.** The only file written by hand or by skill. |
| `~/knowledge/03-Resources/slack-directory.md` | **Generated mirror.** Human-browsable in the vault, git-tracked. Never edited directly — `regen` overwrites it wholesale. |
| `~/knowledge/03-Resources/slack-reply-log.md` | Append-only log of what was drafted, written by `/slack-reply`. |

The mirror exists so the directory is greppable by `kb search` and readable in Tolaria. It
is disposable — if it ever disagrees with the YAML, the YAML wins and `regen` fixes it.
Any action that mutates the registry must run `regen` afterward, or the two drift.

## Actions

| Input | Action |
|-------|--------|
| *(empty)* | Status — entry counts by table, workspace domain, staleness, last regen |
| `init` | Create the registry if missing; discover `workspace.domain` + `team_id` |
| `save <url> [name]` | Parse a Slack permalink → upsert channel/person/thread entries |
| `save <name> <channel-or-user>` | Save by name; resolves the id via search |
| `find <query>` | Resolve a name/alias/topic to a channel or person — registry first, then Slack |
| `list [channels\|people\|threads]` | Print a table of the registry (all tables if unspecified) |
| `sync` | Re-verify every cached id against Slack; flag renamed, archived, or lost-access entries |
| `regen` | Rewrite the vault mirror from the registry |
| `prune` | Drop `threads` entries past 30 / older than 60 days / `status: closed` |
| `remove <key>` | Delete an entry from the registry, then `regen` |

## Steps

1. **Parse the action** from `$ARGUMENTS`. Bare invocation = status.
2. **Read the registry.** If missing and the action isn't `init`, say so and run `init`.
3. **Execute the action** per the table above.
4. **On any mutation, run `regen`** so the vault mirror matches.
5. **Report what changed** — entries added/updated/removed, and anything `sync` flagged.

## Resolving an id (used by `save` and `find`)

Same ladder as `/slack-reply`, cheapest first:

1. **Permalink** → parse directly (see the parser in `/slack-reply` step 1). Zero API calls.
2. **Registry** → grep `aliases`, `name`, and keys, case-insensitive.
3. **Slack** → `mcp__claude_ai_Slack__slack_search_channels` for channels, `mcp__claude_ai_Slack__slack_search_users` for people,
   `mcp__claude_ai_Slack__slack_search_public_and_private` for a thread by content.

Always record **aliases** when saving. The whole point is that "josh", "Josh Heller", and
"UTI Josh" all land on one entry — a directory that only matches the canonical name saves
almost nothing. Add the obvious variants unprompted; ask only when genuinely ambiguous.

## Entry shapes

```yaml
people:
  josh-heller:
    name: Josh Heller
    aliases: [josh, josh h, uti josh]
    user_id: U0XXXXXXXXX      # doubles as channel_id for DMs
    context: UTI + Keymark partnership
    projects: [uti, keymark]
    last_used: 2026-08-04

channels:
  rebel-team:
    name: "#rebel-team"
    aliases: [team, internal]
    channel_id: C0AMDBAJMQE
    type: public              # public | private | dm | group_dm
    purpose: Internal Rebel Ops team channel
    projects: [rebel-ops]
    last_used: 2026-08-04

threads:
  uti-rollout-timeline:
    title: Josh asking when UTI phase 2 lands
    channel_id: C0AMDBAJMQE
    thread_ts: "1754312345.678900"   # PARENT ts — quote it, it's not a number
    with: josh-heller
    first_seen: 2026-08-04
    status: open              # open | replied | closed
```

`thread_ts` must stay a **quoted string**. Unquoted it parses as a float and loses trailing
zeros, which silently breaks the address.

## `sync` details

For each cached entry, confirm it still resolves and still matches:
- Channels — `mcp__claude_ai_Slack__slack_search_channels` on the known name; flag renamed, archived, or missing.
- People — `mcp__claude_ai_Slack__slack_read_user_profile` on the `user_id`; flag deactivated accounts.
- Threads — skip. They're a working set; use `prune` instead.

Do not silently rewrite ids during `sync`. Report the mismatches and let Andrew confirm,
since a "renamed channel" and "a different channel with a similar name" look identical from
search results.

## The generated mirror

`regen` overwrites `~/knowledge/03-Resources/slack-directory.md` with this exact shape:

```markdown
---
strata_id: <PRESERVE the existing UUID — never mint a new one on regen>
type: Note
tags: [slack, directory, generated, ops]
created: <preserve>
modified: <today>
para: resource
generated_from: ~/.claude/projects/-Users-andrewmiller-knowledge/slack/registry.yaml
---

# Slack Directory

> [!warning] Generated file — do not edit by hand.
> Source of truth is `~/.claude/projects/-Users-andrewmiller-knowledge/slack/registry.yaml`.
> Edit there and run `/slack-ctx regen`.

## Channels

| Channel | Aliases | Purpose | Projects | Last used |
|---|---|---|---|---|
| [#rebel-team](https://<domain>.slack.com/archives/C0AMDBAJMQE) | team, internal | Internal Rebel Ops team | rebel-ops | 2026-08-04 |

## People

| Person | Aliases | Context | Projects | Last used |
|---|---|---|---|---|

## Open threads

| Thread | Channel | With | Status | First seen |
|---|---|---|---|---|
```

Build channel URLs as `https://<workspace.domain>.slack.com/archives/<channel_id>` and
thread URLs as `.../archives/<channel_id>/p<thread_ts with the dot removed>`. If
`workspace.domain` is null, emit plain ids and note that `init` hasn't run.

## Notes

- **Read-only against Slack.** This skill never sends or drafts messages — drafting is
  `/slack-reply`'s job, and even that only drafts.
- Channel ids are stable across renames; names are not. Cache the id, treat the name as a label.
- A DM needs no channel lookup — a user's `U…` id works directly as `channel_id`.
- `prune` is cheap and safe. Run it when `threads` gets noisy.
- Related: `/notion-ctx` is the same registry+cache pattern for Notion docs; `/slack-reply`
  is the consumer of this registry.
