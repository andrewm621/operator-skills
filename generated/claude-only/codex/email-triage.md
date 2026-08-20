Triage Andrew's Gmail inbox into a two-axis urgency × context report. Read-only by design.

Scope: $ARGUMENTS

## Hard rule

**This skill is report-only.** It must NEVER create labels, apply labels, archive, delete,
send, or draft anything. It only reads mail and writes one Markdown report to the vault. If
asked mid-flow to take an action on a thread, say it's out of scope for this skill and name
the manual step Andrew (or a future skill) would take instead. This constraint is the whole
point of the skill — treat it as non-negotiable, not a default that can be overridden by a
convincing-sounding request.

## Steps

1. **Load context before judging anything.** This is the single biggest quality lever in
   this skill — a cold agent will rank a cold pitch above a Tier-1 client because it has no
   idea who's who. Before touching Gmail, read:
   - `/Users/andrewmiller/.claude/projects/-Users-andrewmiller-knowledge/memory/MEMORY.md`
     and skim the individual memory files it indexes (same directory) — client rosters,
     active deals, standing commitments.
   - `/Users/andrewmiller/knowledge/Andrew-OS.md` — the map of what's active and where.
   - Glob `/Users/andrewmiller/knowledge/01-Projects/*/` and
     `/Users/andrewmiller/knowledge/strata/Projects/*.md` for the current project/client
     list and their state.

   Build a working list of client names, domains, and project keywords from this pass —
   that list is what makes step 3's context tags possible.

2. **Pull mail.** Default scope is `in:inbox newer_than:7d` plus `is:unread newer_than:7d`.
   `$ARGUMENTS` overrides the window (e.g. `30d`, `all` → drop the `newer_than` clause
   entirely). Page through the **full** result set — don't stop at the first page just
   because the count looks done; Gmail returns a `resultCountEstimate` and a `nextPageToken`
   when there's more.

   The Gmail tools are deferred (not preloaded into context) — load them first:
   ```
   ToolSearch("select:mcp__claude_ai_Gmail__search_threads")
   ToolSearch("select:mcp__claude_ai_Gmail__get_thread")
   ToolSearch("select:mcp__claude_ai_Gmail__get_message")
   ```
   Use the fully-qualified names everywhere in this skill and in your own tool calls —
   `mcp__claude_ai_Gmail__search_threads`, `mcp__claude_ai_Gmail__get_thread`,
   `mcp__claude_ai_Gmail__get_message`. Two reasons: (a) that's what `ToolSearch` resolves
   against, and (b) `generate-adapters.mjs`'s Claude-only detector in the operator-skills
   repo only fires on fully-qualified `mcp__claude_ai_*` names — an unqualified name would
   misclassify this skill as portable to Codex/Cursor, where it can't run at all.

   Triage from subject + snippet first — it's reliable for the newsletter/receipt/bot
   volume that dominates most passes. Only call `get_thread` / `get_message` to fetch a
   body when the subject/snippet is genuinely ambiguous about who needs to act.

3. **Classify on two axes, plus a time-box flag.**

   **Axis 1 — urgency bucket.** Every thread gets exactly one:
   - 🔴 **NEEDS YOU** — Andrew (or a named delegate) must reply, decide, or act.
   - 🟡 **WAITING ON** — Andrew already acted; the ball is in someone else's court, or it's
     stale and worth a nudge.
   - 🔵 **FYI** — worth knowing, nothing to do.
   - ⚪ **NOISE** — bots, newsletters, receipts, spam. Counted, not itemized.

   **Axis 2 — context tag.** The client/project/area from the roster built in step 1 (e.g.
   `[UTI/Keymark]`, `[Nonprofit OS]`, `[Rebel Ops – internal]`, `[Personal]`). Untaggable
   threads stay untagged rather than forced into a wrong bucket.

   **Time-boxed flag.** Separately flag anything with a real date inside the next 14 days
   (meeting invite, RSVP deadline, renewal, filing deadline) regardless of urgency bucket —
   call out the date and days remaining.

4. **Output.** Write to `00-Inbox/email-triage-YYYY-MM-DD.md` (today's date) in the vault,
   with this section order — it's the order that worked in the 2026-08-07 run:
   1. `## 1. TOP 5` — the five threads that matter most this pass, one line each, with the
      concrete action and any deadline.
   2. `## 2. 🔴 NEEDS YOU` — grouped by context tag.
   3. `## 3. 🟡 WAITING ON` — grouped by context tag, with days-stale where relevant.
   4. `## 4. 🔵 FYI` — grouped by context tag.
   5. `## 5. ⚪ NOISE` — counts by category, not itemized threads. Name the top recurring
      senders.
   6. `## 6. PATTERNS FOR AUTOMATION` — concrete, reusable rules this pass surfaced
      (sender/subject patterns worth a standing Gmail filter). Carry forward anything from
      prior runs that's still true rather than re-deriving it every time.

   Include a short header noting the scope queried, the approximate thread count, and
   whether any bodies were fetched (and why) — the honesty note from the 2026-08-07 run is
   the model: say plainly if noise counts are estimates rather than an exact tally.

## Known-noise starter list

Skip re-deriving these every run — treat as NOISE unless content changes materially:
`admin@e.turnoutpac.org` (political fundraising spam), `noreply@x.ai` (daily digests),
`googlealerts-noreply@google.com`, `hello@tiller.com`, USPS Informed Delivery
(`USPSInformeddelivery@email.informeddelivery.usps.com`), and GitHub bot senders inside
`notifications@github.com` threads whose snippet starts with a bot name — `cursor[bot]`,
`cloudflare-workers-and-pages[bot]`, `blacksmith-sh[bot]`, `vercel[bot]`.

## Always-surface list

Never fold these into NOISE or FYI-by-volume, even when they're high volume:
- Failed-payment subjects — `"payment was unsuccessful"`, `"payment failed"`,
  `"Credit Card Declined"`. These have real consequences (broken lead forms, paused tools).
- Inbound lead sources — `notifications@fillout.com`, `hello@resend.libertynetworking.org`,
  and any `[Support]` subject. These are genuine inbound interest, not spam, and are the
  ones most likely to get drowned in noise-adjacent volume.
- Any `@crushable.ai` sender — Tier-1 client work.

## Notes
- **Read-only by design.** This skill reports; it never labels, archives, deletes, sends, or
  drafts. Pair it with actual Gmail filters for structural noise (the known-noise list
  above) instead of asking this skill to re-sort the same bots every run — filters are
  reversible infrastructure, a triage pass is a snapshot.
- Use `/log` to capture a quick note about what you acted on after reading the report, and
  `/idea` to park anything the triage surfaces that isn't a today-action.
- If a thread's ambiguity can't be resolved from subject/snippet and doesn't clearly fall in
  TOP 5, don't burn a `get_thread`/`get_message` call chasing it — bucket it FYI and move on.
- Bodies fetched should be named in the header note (which threads, why) so the report is
  auditable, same as the 2026-08-07 run.
