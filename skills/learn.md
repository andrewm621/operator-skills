Extract, catalog, and recall lessons learned — mistakes, gotchas, surprising behaviors, and solutions. Builds a searchable knowledge base from real work sessions so the same problems don't bite twice.

Arguments: $ARGUMENTS (optional: action and details)

## Actions

| Input | Action |
|-------|--------|
| (empty) | Auto-extract learnings from the current conversation — mistakes, debugging, API quirks, surprising behaviors |
| `"description"` | Capture a specific learning you want to remember |
| `recall <topic>` | Search past learnings for anything relevant before starting work |
| `recall` | Show the full index of all learnings, grouped by category |
| `review [n]` | Review the last N learnings (default 5) for patterns or staleness |
| `stats` | Show learning categories, counts, most-referenced projects |

## Data Location

- Learnings: `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/learnings/YYYY-MM-DD-<slug>.md`
- Index: `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/learnings/INDEX.yaml`
- Also tracked in: `dev-notes/INDEX.md` (Learnings table)

## Steps

### For empty (auto-extract from conversation)

1. **Scan the conversation** for learning signals:
   - Something that took multiple attempts to get right
   - An error that was debugged (especially if the root cause was non-obvious)
   - An API or library that behaved unexpectedly
   - A platform quirk (macOS, Vercel, Supabase, Notion, etc.)
   - A workaround that was needed
   - A pattern that was discovered to be better/worse than expected
   - A tool or config that required non-obvious setup
   - A compatibility issue between tools/versions

2. **For each learning found**, extract:
   - **Title**: short, specific (e.g., "macOS BSD grep doesn't support \\s")
   - **Category**: one of `api-quirks`, `platform`, `debugging`, `architecture`, `performance`, `tooling`, `security`, `patterns`, `compatibility`
   - **Tags**: 2-5 searchable keywords (e.g., `[grep, macos, regex, posix]`)
   - **Project(s)**: which project(s) this applies to
   - **The problem**: what happened or what was surprising
   - **The solution**: what fixed it or what the correct approach is
   - **Why it's non-obvious**: why someone would hit this again

3. **Present the extracted learnings** to the user for confirmation. Show each one in compact form:
   ```
   Found 2 learnings this session:

   1. [platform] macOS BSD grep doesn't support \s
      Tags: grep, macos, regex, posix
      Problem: \s in grep pattern silently fails on macOS
      Solution: Use .* instead for POSIX portability
      Save? [Y/n]

   2. [api-quirks] Notion MCP create-pages requires data_source_id not database_id
      Tags: notion, mcp, database
      ...
   ```

4. **Save confirmed learnings** — write each to a markdown file and update the index.

### For `"description"` (manual capture)

1. Parse the description for context. Ask clarifying questions if needed:
   - What was the problem or surprise?
   - What's the solution or correct approach?
   - Which project(s) does this apply to?

2. **Categorize and tag** automatically, confirm with user.

3. **Save** the learning file and update the index.

### For `recall <topic>` (search before starting work)

This is the **most important action** — it surfaces past lessons before you repeat mistakes.

1. **Read the index** at `dev-notes/learnings/INDEX.yaml`

2. **Search** against the topic using multiple strategies:
   - Exact tag match (e.g., `recall supabase` matches tag `supabase`)
   - Project match (e.g., `recall agencyos` matches project `agencyos`)
   - Category match (e.g., `recall security` matches category `security`)
   - Fuzzy keyword match against titles and summaries
   - Broad technology match (e.g., `recall auth` matches tags containing `auth`, `supabase-auth`, `entra`, `clerk`, `otp`)

3. **Display matches** ranked by relevance:
   ```
   ## Relevant Learnings for "supabase auth"

   ### Direct matches (3)

   1. **Supabase + Resend + Custom OTP Auth Gotchas** (2026-04-22, agencyos)
      - Supabase-Resend integration key is scoped — use separate Resend API key for direct sends
      - createUser before generateLink — "Signups not allowed" if user doesn't exist
      - Custom OTP pattern: generate OTP → send via Resend → verify via admin.generateLink
      [Full: dev-notes/learnings/2026-04-22-supabase-resend-auth-gotchas.md]

   2. **Supabase RLS Security Audit** (2026-04-29, all)
      - SECURITY DEFINER functions callable by anon
      - mutable search_path vulnerability
      [Full: dev-notes/learnings/2026-04-29-supabase-rls-security-definer-audit.md]

   ### Tangential matches (1)

   3. **CF Workers: Use Web Crypto API** (2026-04-22, agencyos)
      - No Node.js crypto in Workers — use crypto.subtle
   ```

4. **Offer to load full content** for any match: "Read the full learning? (1/2/3/all)"

### For `recall` (no topic — show full index)

1. Read the index and display all learnings grouped by category:
   ```
   ## Learning Index (18 entries)

   ### api-quirks (5)
   - Zoom API Quirks [zoom, oauth, s2s] (cloud-archiver)
   - Notion API sync quirks [notion, api, rate-limits] (notion-sync)
   - Spiro CSV field mapping [csv, import, field-mapping] (westonmediaOS)
   ...

   ### platform (4)
   - macOS bash 3.x compat [bash, macos, arrays] (all)
   - Stop hook exit codes [hooks, claude-code] (all)
   ...
   ```

### For `review [n]`

1. Read the last N learning files (by date, default 5).
2. For each, show the title and key facts.
3. Ask: "Still accurate? Any updates needed?"
4. If the user provides corrections, update the file.
5. Check for **patterns across learnings**:
   - Same project appearing repeatedly → suggest adding a CLAUDE.md section
   - Same category clustering → suggest a checklist or convention
   - Learning that's now covered by tooling → suggest marking as resolved

### For `stats`

1. Read the index and compute:
   - Total learnings count
   - Learnings per category (bar chart with ASCII)
   - Learnings per project (top 10)
   - Learnings per month (trend)
   - Most common tags
2. Suggest: "Projects with 3+ learnings might benefit from a project-specific gotchas section in CLAUDE.md"

## Index Format

The index at `dev-notes/learnings/INDEX.yaml` is a compact lookup table:

```yaml
# Learning Index — auto-maintained by /learn skill
# Source of truth for recall searches. Rebuild from files if corrupted.

entries:
  - file: 2026-04-22-supabase-resend-auth-gotchas.md
    title: Supabase + Resend + Custom OTP Auth Gotchas
    category: api-quirks
    tags: [supabase, resend, auth, otp, cloudflare-workers]
    projects: [agencyos]
    summary: Scoped integration key vs full API key; createUser before generateLink; Web Crypto in CF Workers
    date: 2026-04-22

  - file: 2026-05-13-zoom-api-quirks.md
    title: Zoom API Quirks
    category: api-quirks
    tags: [zoom, oauth, s2s, api, recordings]
    projects: [cloud-archiver]
    summary: Granular scopes, 1-month date limits, double UUID encoding, download URL expiry, 0-size transcripts
    date: 2026-05-13
```

## Learning File Format

Follow the existing format in `dev-notes/learnings/`:

```markdown
# Learning: <Title>

Date: YYYY-MM-DD | Project(s): <project list>

## <Specific Gotcha 1>

<What happened or what was surprising>

**Solution**: <What fixes it or what the correct approach is>

## <Specific Gotcha 2>

...
```

Each learning file can contain multiple related gotchas (like the Supabase auth file has 4 related items).

## Rules

1. **Specificity over generality** — "macOS BSD grep doesn't support \\s" is useful. "grep can be tricky" is not. Include the exact error, the exact fix, and why it's non-obvious.
2. **One file per topic cluster** — group related gotchas in one file (like "Zoom API Quirks" with 6 items). Don't create one file per gotcha.
3. **Tags are for machine search** — use lowercase, specific terms. Prefer `supabase-auth` over `authentication`. Include the tool/service name.
4. **Update, don't duplicate** — if a learning already exists for the same topic, update the existing file with new gotchas rather than creating a new one.
5. **Always update INDEX.yaml** — every new or modified learning must be reflected in the index.
6. **Always update INDEX.md** — add the entry to the Learnings table in `dev-notes/INDEX.md`.
7. **Cross-reference** — if a learning would prevent a bug in a specific project, mention it. "If you're touching AgencyOS auth, read this first."
8. **Don't capture obvious things** — "you need to install dependencies before building" is not a learning. Focus on things that are genuinely surprising or that caused real debugging time.
9. **Recall is the default suggestion** — when a user starts work on a topic that has past learnings, proactively suggest: "There are N learnings related to <topic>. Run `/learn recall <topic>` first?"
