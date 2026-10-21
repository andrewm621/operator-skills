---
name: notion
description: >
  Sync work progress, decisions, and notes to any project's Notion workspace. Auto-detects project from cwd via the notion-context registry. Creates dev notes, updates existing pages, searches for context, and keeps project workspaces current. `/notion ctx ...` manages that registry and its cached page summaries for fast, token-efficient context loading.
argument-hint: "[note|update|search|status|idea|decision|link|scaffold|infra|ctx] [details]"
---

Sync work progress, decisions, and notes to any project's Notion workspace. Auto-detects project from cwd via the notion-context registry. Creates dev notes, updates existing pages, searches for context, and keeps project workspaces current. `/notion ctx ...` manages that registry and its cached page summaries for fast, token-efficient context loading.

Arguments: $ARGUMENTS (optional: action and details)

## Actions

| Input | Action |
|-------|--------|
| (empty) | Auto-generate a dev note from recent conversation context and add it to the project's Notes database |
| `note "title"` or `"some text"` | Create a targeted dev note with the given title/content |
| `update <topic>` | Find and update an existing Notion page related to the topic |
| `search <query>` | Search the project's workspace for pages matching the query |
| `status` | Show the current state of key workspace pages (hub, roadmap, recent notes) |
| `idea "title"` | Create a new idea entry |
| `decision "title"` | Document a decision with context, alternatives, and rationale |
| `link` | Show all known Notion page URLs for the current project |
| `scaffold <project>` | Create Notion hub + Notes DB for a project and register it |
| `infra [tag]` | Show infrastructure context pages, optionally filtered by tag |
| `ctx [action] ...` | Manage the context registry and cached page summaries (sync, add, load, discover, ...). See "Context registry" below |

## Tool Strategy

**Primary: `ntn` CLI** (Notion CLI, resolved from `PATH`) -- uses far fewer tokens than MCP tool calls. If `ntn` is not on `PATH` (e.g. a machine where only the Notion MCP is configured), skip it and use the MCP fallback below for every step.
- `ntn pages create` -- create pages with markdown content via stdin or `--content`
- `ntn pages get <id>` -- fetch page content as markdown with frontmatter
- `ntn pages update <id>` -- update page content via stdin or `--content`
- `ntn pages trash <id> --yes` -- trash a page
- `ntn datasources query <ds-id>` -- query database pages (supports `--filter`, `--limit`)

**Fallback: Notion MCP** -- use only when `ntn` cannot do the job:
- `mcp__claude_ai_Notion__notion-search` -- full-text search (ntn has no search command)
- `mcp__claude_ai_Notion__notion-create-pages` -- when you need to set database properties (Name, Date, Description) beyond what markdown frontmatter supports
- `mcp__claude_ai_Notion__notion-update-page` -- when you need property updates (not content updates)
- `mcp__claude_ai_Notion__notion-create-database` -- when scaffolding a new Notes DB

**When creating database entries with properties**, use the Notion MCP `notion-create-pages` tool since `ntn pages create` doesn't support setting database properties like Date and Description. For content-only pages (under a parent page, not a database), prefer `ntn`.

## Notion Workspace Reference

**Source of truth:** `~/.claude/notion-context/registry.yaml`

> Machine-independent location. Older installs kept this under
> `~/.claude/projects/<project-slug>/notion-context/`; if that path exists and
> `~/.claude/notion-context/` does not, move it there once:
> `mv ~/.claude/projects/*/notion-context ~/.claude/notion-context`.

### Project Resolution (Step 0 -- runs before every action)

1. Get cwd
2. Read registry.yaml and collect every project's `dir` value
3. Match by walking cwd from the deepest component upward: for each path
   component (starting at the basename), check if it equals any project's `dir`.
   The first match wins. This is root-agnostic — it works whether projects live
   under a projects folder, `~/<dir>/`, or anywhere else.
   - e.g. `~/code/myapp/v2/src/` -> tries `src`, `v2`,
     `myapp` -> matches `myapp`
   - e.g. `C:\Users\Jane\notes` -> tries `notes` -> matches `notes`
4. Fuzzy fallback: normalize both sides (lowercase, strip spaces/hyphens), compare each cwd component against project keys
5. If no match: ask user which project, or check if first argument is a project key
6. If still unresolved: ask which project to use (or suggest `/notion scaffold <project>`). There is no default project.
7. Output: `[notion: <project-key>]` at start of response

After resolution, use these from the matched project entry:
- `$HUB` -- hub page ID (parent for sub-pages)
- `$NOTES_DB` -- notes database data source ID (parent for DB entries)
- `$PAGES` -- registered pages (for `link` and `update` lookups)

### Standard Notes DB Schema (all projects)
- Name (title), Description (text), Date, URL, Parent item (relation), Sub-item (relation)

### If the registry is unavailable
Don't guess IDs. Ask the user for the hub page URL and Notes database (data source) ID, or run `/notion scaffold <project>` to create and register them.

## Steps

### For `note` or empty (auto-generate dev note)

1. **Resolve project** (Step 0 above). If `$NOTES_DB` is null, tell user to run `/notion scaffold <project>` first.

2. **Gather context** -- Analyze the current conversation for:
   - What was worked on (features, fixes, refactors)
   - Key decisions made and rationale
   - Files changed (from git or conversation)
   - Blockers encountered
   - What's next

3. **Create the note** -- Use `mcp__claude_ai_Notion__notion-create-pages` with:
   - Parent: `{"data_source_id": "$NOTES_DB"}`
   - Properties: `{"Name": "<title>", "date:Date:start": "YYYY-MM-DD", "date:Date:is_datetime": 0, "Description": "<one-line summary>"}`
   - Content with sections: What Was Done, Decisions, Files Changed, Next Steps

4. **Confirm** -- Show the user the created note title and Notion URL.

### For `update <topic>`

1. **Resolve project** (Step 0).

2. **Search** -- Check `$PAGES` from the registry first for an exact match. If no match, use `mcp__claude_ai_Notion__notion-search` to find the page.

3. **Fetch current content** -- Use `ntn pages get <page-id>` to read the page as markdown.

4. **Determine updates** -- From conversation context, identify what needs updating. Show the user a summary of proposed changes.

5. **Apply updates** -- Pipe updated markdown to `ntn pages update <page-id>`:
   ```bash
   echo '<updated markdown>' | ntn pages update <page-id>
   ```
   For targeted search-and-replace or property-only updates, use `mcp__claude_ai_Notion__notion-update-page` instead.

6. **Confirm** -- Show what was changed.

### For `search <query>`

1. **Resolve project** (Step 0).
2. Use `mcp__claude_ai_Notion__notion-search` with the query.
3. Display results with titles, URLs, and brief highlights.
4. Offer to fetch any result with `ntn pages get <id>`.

### For `status`

1. **Resolve project** (Step 0).
2. If `$HUB` is set: Fetch the hub page: `ntn pages get $HUB`
3. If `$NOTES_DB` is set: Query recent notes: `ntn datasources query $NOTES_DB --limit 10`
4. Summarize: what pages exist, recent activity, any action items found.

### For `idea "title"`

1. **Resolve project** (Step 0). If `$NOTES_DB` is null, tell user to run `/notion scaffold <project>` first.

2. Use `mcp__claude_ai_Notion__notion-create-pages` with:
   - Parent: `{"data_source_id": "$NOTES_DB"}`
   - Properties: `{"Name": "<title>", "date:Date:start": "YYYY-MM-DD", "date:Date:is_datetime": 0}`
   - Content describing the idea
3. If the user provided additional context, include it in the content body.

### For `decision "title"`

1. **Resolve project** (Step 0). If `$NOTES_DB` is null, tell user to run `/notion scaffold <project>` first.

2. Use `mcp__claude_ai_Notion__notion-create-pages` with:
   - Parent: `{"data_source_id": "$NOTES_DB"}`
   - Properties: `{"Name": "Decision: <title>", "date:Date:start": "YYYY-MM-DD", "date:Date:is_datetime": 0, "Description": "<one-line summary>"}`
   - Content:
     ```
     ## Context
     Why this decision was needed

     ## Decision
     What was chosen

     ## Alternatives Considered
     What was rejected and why

     ## Impact
     What this affects going forward
     ```

### For `link`

1. **Resolve project** (Step 0).
2. Display all pages from `$PAGES` in the registry as a clean table: Name, Slug, Tags, Notion URL.
3. If `$HUB` is set, include the hub page link at the top.
4. If `$NOTES_DB` is set, include a link to the notes database.

### For `scaffold <project>`

1. **Validate** -- Confirm the project has a local directory (its `dir`, resolvable from cwd or a known projects root), unless `dir` is null (e.g., `infrastructure`). Check if already in registry.
   - If already has hub + notes_db: "Already scaffolded. Run `/notion status`."
   - If in registry but missing notes_db: offer to create just the DB.

2. **Get or create workspace parent** -- Read `workspace_parent` from registry.
   - If null: create a workspace-level page titled "Claude Code Workspaces" via
     `mcp__claude_ai_Notion__notion-create-pages` (no parent). Store its ID as
     `workspace_parent` in registry.

3. **Create hub page** -- `mcp__claude_ai_Notion__notion-create-pages`:
   - parent: `{ "page_id": "<workspace_parent>" }`
   - title: `"<Label> -- Dev Workspace"`
   - content: Overview section + placeholder sections (Key Decisions, Architecture)

4. **Create Notes database** -- `mcp__claude_ai_Notion__notion-create-database`:
   - parent: `{ "page_id": "<new_hub_id>" }`
   - title: `"<Label> Notes"`
   - schema: Name (title), Description (rich_text), Date (date), URL (url)
   - Note: Self-relations (Parent item/Sub-item) require a second call via
     `mcp__claude_ai_Notion__notion-update-data-source` after creation.
     Skip self-relations on initial scaffold -- add manually if needed.

5. **Register** -- Update registry.yaml:
   - Add/update project entry with label, description (ask user), dir, hub, notes_db
   - Update workspace_parent if newly created

6. **Confirm** -- Show hub URL, Notes DB URL, and suggest next steps:
   - "Run `/notion ctx add <project> <page-id>` to register existing pages"
   - "Run `/notion ctx discover <project>` to find related Notion pages"

### For `infra [tag]`

1. Read registry, find the `infrastructure` project.
2. List registered pages with tags.
3. If tag provided: filter pages to matching tag.
4. Show `context_packs` references: "Related skills: `my-infra-context-pack:*`, `vercel-plugin:*`"
5. Offer: "Load context with `/notion ctx load infrastructure [--tags <tag>]`"

## Context registry (`/notion ctx`)

Manages the per-project registry of relevant Notion documents and a cache of compact summaries, so a project's Notion knowledge can be loaded into a conversation cheaply instead of re-fetching whole pages. The registry is the same `registry.yaml` the actions above resolve projects from.

If `$ARGUMENTS` starts with `ctx`, drop that word and treat the rest as one of the actions below. If a `<project>` argument is omitted for `sync`, `load`, `list`, or `review`, resolve it with Step 0 above.

### Data location

- Registry: `~/.claude/notion-context/registry.yaml`
- Cache: `~/.claude/notion-context/cache/<project>.yaml`

(Same machine-independent location and one-time migration note as in the Notion Workspace Reference above.)

### Context actions

| Input | Action |
|-------|--------|
| `ctx` | Show registry status: all projects, page counts, cache freshness |
| `ctx sync` | Refresh ALL project caches from Notion |
| `ctx sync <project>` | Refresh one project's cache from Notion |
| `ctx sync <project> <slug>` | Refresh a single page's cache |
| `ctx add <project> [page-id] [name]` | Register a new page (interactive if no page-id) |
| `ctx remove <project> <slug>` | Remove a page from the registry and cache |
| `ctx load <project>` | Load all cached context for a project into the conversation |
| `ctx load <project> <slug>` | Load one page's cached context |
| `ctx load <project> --tags <tag>` | Load pages matching a tag |
| `ctx discover <project>` | Search Notion for pages that might be relevant to a project |
| `ctx list <project>` | List all registered pages for a project with their slugs and tags |
| `ctx new <project>` | Create a new empty project entry in the registry |
| `ctx review <project>` | Show cached summaries for the user to confirm, deny, or edit |

### Registry format

```yaml
workspace_parent: <page-id>   # optional: parent page for scaffolded hubs
projects:
  <project-key>:
    label: Human-readable name
    description: One-line project description
    dir: <directory-name>      # Matched against cwd path components for auto-detection (root-agnostic); null if no local dir
    hub: <page-id>             # Optional hub/parent page
    notes_db: <datasource-id>  # Optional notes database
    pages:
      <slug>:
        id: <notion-page-id>
        name: Human-readable page title
        tags: [tag1, tag2]
```

### Cache format

Each project gets one cache file at `~/.claude/notion-context/cache/<project>.yaml`:

```yaml
project: <project-key>
label: Human-readable name
last_sync: YYYY-MM-DD
page_count: N
pages:
  <slug>:
    id: <notion-page-id>
    name: Page title
    synced: YYYY-MM-DD
    stale: false
    summary: >
      2-4 sentence summary of the page's purpose and key content.
    sections:
      - "Section Title: one-line summary of that section"
    key_facts:
      - "Fact: concise bullet"
    tags: [tag1, tag2]
```

### For `ctx` (status)

1. Read `registry.yaml`
2. For each project, check whether `cache/<project>.yaml` exists and, if so, its `last_sync` date
3. Report:

```
## Notion Context Registry

| Project | Pages | Last Sync | Status |
|---------|-------|-----------|--------|
| web-app | 15 | 2026-05-21 | Fresh (today) |
| api-service | 3 | 2026-05-18 | Stale (3d ago) |
| side-project | 0 | never | No cache |

Total: 18 pages across 3 projects
```

### For `ctx sync`

1. Read `registry.yaml` to get the target project(s) and their pages
2. For each page to sync:
   a. Fetch content: `ntn pages get <page-id>` (or the Notion MCP fetch if `ntn` isn't available)
   b. **Summarize** the content into the cache format:
      - `summary`: 2-4 sentences capturing purpose and key content
      - `sections`: list of "Section: one-line summary" for each heading
      - `key_facts`: the 5-10 most important specific facts (numbers, names, dates, decisions)
   c. Preserve the page's `tags` from the registry
3. Write the compiled cache file to `cache/<project>.yaml`
4. Report what was synced and any pages that failed

**Summarization rules:**
- Be ruthlessly concise; these load into context and every token counts
- Prioritize specific facts over vague descriptions ("$49/mo pricing" not "competitive pricing")
- Include numbers, dates, names, and decisions; skip fluff
- If a page is very long, focus on sections that contain decisions, requirements, or specs
- Sections list should use the actual heading text from the document
- Max ~15 key_facts per page, aim for 5-10

### For `ctx add`

1. Read the registry
2. If `<page-id>` was provided:
   a. Fetch the page: `ntn pages get <page-id>`
   b. Extract the title from the frontmatter `Name` field
   c. Generate a slug from the name (lowercase, hyphens, no special chars)
   d. Ask the user for tags (suggest based on content)
   e. Add it to the registry under the project
3. If no `<page-id>`: ask for the Notion page URL or ID, then continue as above
4. Write the updated registry
5. Offer to sync the newly added page

### For `ctx remove`

1. Read the registry
2. Find and remove the page entry for `<project>/<slug>`
3. Write the updated registry
4. If a cache exists, remove the page from the cache file too
5. Confirm the removal

### For `ctx load`

1. Read `cache/<project>.yaml`
2. If no cache exists, suggest running `ctx sync` first
3. Filter by slug or tags if specified
4. Output the cached context in a compact, readable format:

```
## Notion Context: <Project Label>
Synced: <date> | Pages: <N>

### <Page Name> [slug: <slug>]
<summary>

Sections: <section summaries as bullets>

Key facts:
- fact 1
- fact 2

---
### <Next Page Name> ...
```

**Important:** The load output IS the context injection. Keep it tight. No redundant headers or metadata beyond what's useful for understanding.

### For `ctx discover`

1. Use `mcp__claude_ai_Notion__notion-search` with the project name and related terms
2. Cross-reference the results against already-registered pages
3. Show unregistered pages that look relevant:

```
## Discovered Notion Pages for <project>

Already registered: 15 pages
New candidates:
| Title | ID | Relevance |
|-------|-----|-----------|
| Marketing Budget Q2 | abc123... | pricing, marketing |
| Client Onboarding Flow | def456... | operations |

Add with: /notion ctx add <project> <page-id>
```

### For `ctx list`

1. Read the registry
2. Show the project's registered pages as a table: slug, name, tags, last synced (from the cache if present)

### For `ctx new`

1. Read the registry
2. Determine the project's local directory name if it has one, and set `dir` accordingly (null if no local directory)
3. Add a new empty project entry:
   ```yaml
   <project>:
     label: <ask user>
     description: <ask user>
     dir: <directory-name or null>
     pages: {}
   ```
4. Write the updated registry
5. Suggest `ctx discover` or `ctx add` to populate pages
6. To create a full Notion workspace (hub + Notes DB), use `/notion scaffold <project>`

### For `ctx review`

1. Read `cache/<project>.yaml`
2. For each page, display the cached summary and key facts
3. Ask the user to confirm, edit, or flag as stale
4. If the user provides corrections, update the cache file directly
5. If flagged as stale, mark `stale: true` in the cache (the next sync will refresh it)

## Rules

1. **Prefer `ntn` CLI over MCP** for reads and content writes -- it's faster and cheaper on tokens. Use MCP only for search, database property operations, and scaffold.
2. **Date format** -- Always use ISO-8601 (`YYYY-MM-DD`) for date properties.
3. **Fetch before update** -- Always read a page's current content before modifying it.
4. **Don't overwrite blindly** -- When updating, show proposed changes to the user first.
5. **Confirm destructive changes** -- If an update would remove significant content, get user approval.
6. **Keep notes concise** -- Dev notes should be scannable, not exhaustive. Bullet points over paragraphs.
7. **Link to code** -- When referencing code changes, include file paths and brief descriptions.
8. **Cross-reference** -- If a note relates to an existing page (PRD, roadmap, etc.), mention it in the note content.
9. **Escape markdown** -- When passing content via `--content` flag, use heredoc or stdin pipe to avoid shell escaping issues:
   ```bash
   cat <<'NOTION_EOF' | ntn pages update <page-id>
   # Title
   Content here
   NOTION_EOF
   ```
10. **Project context** -- Always show `[notion: <project>]` at start of output to confirm which project was resolved.
11. **Registry-driven** -- Never hardcode page IDs. All IDs come from the resolved project entry in registry.yaml.

### Rules for `ctx`

1. **Token efficiency is paramount** -- summaries must be compact. A 5000-word Notion page should compress to ~200 tokens of cache.
2. **Fetch before summarize** -- always read the actual Notion content, never guess.
3. **Registry is the source of truth** -- the cache can be rebuilt from registry + Notion at any time.
4. **Slug stability** -- once a slug is assigned, don't change it. Other systems may reference it.
5. **Non-destructive sync** -- `sync` overwrites the cache but never modifies the registry. `add`, `remove`, and `new` modify the registry.
6. **Parallel fetching** -- when syncing multiple pages, fetch them in parallel (up to 5 concurrent `ntn` calls).
7. **Report failures gracefully** -- if a page fetch fails (deleted, permissions), note it in the report but don't remove it from the registry.
