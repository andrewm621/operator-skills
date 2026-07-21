Sync work progress, decisions, and notes to any project's Notion workspace. Auto-detects project from cwd via the notion-context registry. Creates dev notes, updates existing pages, searches for context, and keeps project workspaces current.

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
   under `~/Projects/<dir>/`, `~/<dir>/`, or anywhere else.
   - e.g. `/Users/andrewmiller/Projects/agencyos/v2/src/` -> tries `src`, `v2`,
     `agencyos` -> matches `agencyos`
   - e.g. `C:\Users\Andrew\knowledge` -> tries `knowledge` -> matches `knowledge`
4. Fuzzy fallback: normalize both sides (lowercase, strip spaces/hyphens), compare each cwd component against project keys
5. If no match: ask user which project, or check if first argument is a project key
6. If still unresolved and no arguments: default to `rebelsites` for backward compat
7. Output: `[notion: <project-key>]` at start of response

After resolution, use these from the matched project entry:
- `$HUB` -- hub page ID (parent for sub-pages)
- `$NOTES_DB` -- notes database data source ID (parent for DB entries)
- `$PAGES` -- registered pages (for `link` and `update` lookups)

### Standard Notes DB Schema (all projects)
- Name (title), Description (text), Date, URL, Parent item (relation), Sub-item (relation)

### Fallback: RebelSites (if registry unavailable)
Hub: 30283fe625a68131b2d2f2675cf033bb
Notes DB: 30283fe6-25a6-8110-a94c-000b41e8741a (data source)
Templates: Dev Notes @Today (30283fe6-25a6-818c-992e-ffe1219cc0b7), New Idea (30283fe6-25a6-810a-b60c-dd274b54c60b)

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
   - "Run `/notion-ctx add <project> <page-id>` to register existing pages"
   - "Run `/notion-ctx discover <project>` to find related Notion pages"

### For `infra [tag]`

1. Read registry, find the `infrastructure` project.
2. List registered pages with tags.
3. If tag provided: filter pages to matching tag.
4. Show `context_packs` references: "Related skills: `azure-uti-context-pack:*`, `vercel-plugin:*`"
5. Offer: "Load context with `/notion-ctx load infrastructure [--tags <tag>]`"

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
11. **Registry-driven** -- Never hardcode page IDs except in the fallback block. All IDs come from the resolved project entry in registry.yaml.
