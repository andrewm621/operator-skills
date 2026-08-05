---
name: slack-reply
description: >
  Draft a reply to a Slack message or thread in Andrew's voice. Resolves the target from a
  pasted URL, the local Slack directory, or search; reads the thread for context; stages the
  reply as a Slack draft for approval. Never sends.
argument-hint: "<Slack URL, or who/what you're replying to>"
---

Draft a reply to a Slack message or thread and stage it as a Slack draft for approval.

Target: $ARGUMENTS

## Hard rule

**This skill never sends.** It writes into Slack's "Drafts & Sent" via
`mcp__claude_ai_Slack__slack_send_message_draft`. Andrew reviews in Slack and hits enter. Do not call
`mcp__claude_ai_Slack__slack_send_message` or `mcp__claude_ai_Slack__slack_schedule_message` from this skill under any circumstance —
not even if asked mid-flow. If Andrew wants it sent, tell him it's drafted and waiting.

## Data

- Registry (source of truth): `~/.claude/projects/-Users-andrewmiller-knowledge/slack/registry.yaml`
- Reply log (append-only): `~/knowledge/03-Resources/slack-reply-log.md`
- Managed by `/slack-ctx` — this skill reads the registry and appends to it, but structural
  edits and the vault mirror are `/slack-ctx`'s job.

## Steps

### 1. Resolve the target — cheapest tier first, stop at the first hit

**Tier 1 — a Slack URL was pasted.** Zero API calls; the URL *is* the address. Parse it:

```bash
python3 - "$SLACK_URL" <<'PY'
import sys, re, urllib.parse as up
p = up.urlparse(sys.argv[1]); q = up.parse_qs(p.query)
m = re.search(r'/(?:archives|messages)/([A-Z0-9]+)(?:/p(\d{12,}))?', p.path)
if not m: sys.exit("not a Slack permalink")
cid, raw = m.group(1), m.group(2)
ts = f"{raw[:10]}.{raw[10:]}" if raw else None
print(f"domain={p.netloc.split('.')[0]}")
print(f"channel_id={cid}")
print(f"message_ts={ts}")
# If thread_ts is present the clicked message is a REPLY; the parent is thread_ts.
print(f"reply_to={q.get('thread_ts', [ts])[0] if ts else ''}")
PY
```

`reply_to` is the value to pass as `thread_ts` when drafting. A `C…` channel_id is a
channel, `D…` is a DM, `U…` is a user (usable directly as channel_id for a DM).
If `workspace.domain` in the registry is null, write the parsed `domain` into it now.

**Tier 2 — a name, nickname, or channel.** Grep the registry's `aliases`, `name`, and key
fields (case-insensitive). A hit gives `channel_id` with zero API calls. If the ask names a
person *and* a topic ("Josh about the UTI timeline"), also check `threads` for an open
thread matching both.

**Tier 3 — search Slack.** Only on a Tier 1+2 miss.
- `mcp__claude_ai_Slack__slack_search_public_and_private` — semantic search is enabled on this account, so
  natural-language queries work ("question about the UTI rollout timeline"). Narrow with
  modifiers: `from:@josh`, `in:#rebel-team`, `after:2026-07-28`, `is:thread`.
- `mcp__claude_ai_Slack__slack_search_channels` when the target is a channel, not a message.
- `mcp__claude_ai_Slack__slack_search_users` when the target is a DM and you need the `U…` id.

Show the top 3 candidates with channel, author, date, and first line, and ask which one —
unless exactly one plausible hit exists.

**Cache the miss, not the hit.** Only when Tier 3 did real work, write what it found back
into the registry (a `people` or `channels` entry, plus a `threads` entry). A Tier 1/2
resolution needs no write beyond bumping `last_used`.

### 2. Read the thread before drafting

Call `mcp__claude_ai_Slack__slack_read_thread` with `channel_id` + `message_ts` (the parent). For a channel with
no thread, `mcp__claude_ai_Slack__slack_read_channel` with a small `limit` for surrounding context.

Read it properly — the point is to answer **what was actually asked**, and to notice if
someone already answered it, if the ask changed partway down, or if there are two open
questions and Andrew only remembered one. Say so if that's the case.

If any participant is unknown, `mcp__claude_ai_Slack__slack_read_user_profile` for name and role.

### 3. Draft in Andrew's voice, tuned for Slack

Voice source: `/Users/andrewmiller/Projects/AI Agent Teams/live/agents/writing.md`. Read it
if the reply is client-facing or longer than a couple of lines. Skip it for a one-line
internal ack.

Slack register differs from email — apply these on top of the voice guide:
- Lead with the answer. No "Hey! Great question —".
- Short paragraphs, blank line between. No email sign-off, no salutation in a thread.
- Concrete commitments carry a date: "by Thursday", not "soon".
- Bullets only for 3+ parallel items. Two items is a sentence.
- Slack markdown: `*bold*` renders as bold in Slack, `_italic_`, `` `code` ``, `>quote`.
  The draft tool takes standard markdown and converts — write standard `**bold**`.
- Match the thread's formality. A client channel is not `#rebel-team`.
- If the honest answer is "I don't know yet", draft that plus when he'll know. Do not
  invent a status, a date, or a delivery claim. Pull real state from the vault
  (`kb context <project>`, `strata/Projects/`) rather than guessing.

Flag rather than paper over: if answering requires a fact you don't have, put
`[NEEDS: what's the actual Keymark go-live date?]` inline and tell Andrew in your summary.

### 4. Show it, then stage it

Print the draft in the terminal first, with the target ("→ #rebel-team, thread w/ Josh,
2 replies"). On approval call `mcp__claude_ai_Slack__slack_send_message_draft`:

- `channel_id` — the resolved id (`C…`, `D…`, or `U…` for a DM)
- `thread_ts` — **always set this** when replying to a thread. Omitting it posts to the
  channel instead of the thread, which is the most common and most visible failure here.
- `message` — the approved text

Error handling:
- `draft_already_exists` — only one attached draft per channel. Report it and offer to
  (a) open the channel so Andrew clears the old one, or (b) print the text for manual
  paste. Do not attempt to delete the existing draft.
- `channel_not_found` — the cached id is stale or access was lost. Re-resolve via Tier 3
  and correct the registry entry.

### 5. Log it

Append one row to `~/knowledge/03-Resources/slack-reply-log.md` under today's date:

```markdown
- **2026-08-04** — [#rebel-team / Josh Heller](https://<domain>.slack.com/archives/C.../p...) — UTI phase 2 timeline — *drafted, awaiting send*
```

Then update the registry: bump `last_used` on the person/channel, and upsert the `threads`
entry with `status: replied`. Keep `threads` at 30 entries max, dropping least-recently-used.

## Notes

- **Never sends.** See the hard rule above. `/slack-ctx` also never sends.
- Use `/slack-ctx` to manage the directory: `save`, `find`, `list`, `sync`, `regen`, `prune`.
- If the registry doesn't exist yet, run `/slack-ctx init` first.
- The fastest path is pasting the Slack permalink (⌥-click a message → Copy link). It skips
  all search and is unambiguous about which thread.
- For a *new* message rather than a reply, this still works — resolve the channel, omit
  `thread_ts`. But say so explicitly, since replies are the default assumption.
- Related: `/notion-ctx` is the same registry+cache pattern for Notion docs.
