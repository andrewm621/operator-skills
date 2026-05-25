---
name: notion-ctx
description: >
  Manage a per-project registry of relevant Notion documents with cached summaries for fast context loading. Keeps Notion knowledge fresh and token-efficient.
argument-hint: "optional: action and target"
---

Manage a per-project registry of relevant Notion documents with cached summaries for fast context loading. Keeps Notion knowledge fresh and token-efficient.

Arguments: $ARGUMENTS (optional: action and target)

## Data Location

- Registry: `~/.claude/projects/-Users-andrewmiller-Projects/notion-context/registry.yaml`
- Cache: `~/.claude/projects/-Users-andrewmiller-Projects/notion-context/cache/<project>.yaml`

## Actions

| Input | Action |
|-------|--------|
| (empty) | Show registry status — all projects, page counts, cache freshness |
| `sync` | Refresh ALL project caches from Notion |
| `sync <project>` | Refresh one project's cache from Notion |
| `sync <project> <slug>` | Refresh a single page's cache |
| `add <project> [page-id] [name]` | Register a new page (interactive if no page-id) |
| `remove <project> <slug>` | Remove a page from registry and cache |
| `load <project>` | Load all cached context for a project into conversation |
| `load <project> <slug>` | Load one page's cached context |
| `load <project> --tags <tag>` | Load pages matching a tag |
| `discover <project>` | Search Notion for pages that might be relevant to a project |
| `list <project>` | List all registered pages for a project with their slugs and tags |
| `new <project>` | Create a new empty project entry in the registry |
| `review <project>` | Show cached summaries for user to confirm/deny/edit |

## Tool Strategy

**Primary: `ntn` CLI** (`/usr/local/bin/ntn`) — far fewer tokens than MCP.
- `ntn pages get <id>` — fetch page as markdown with frontmatter
- `ntn datasources query <ds-id>` — query database pages

**Fallback: Notion MCP** — only for search (ntn has no search command).
- `mcp__claude_ai_Notion__notion-search` — full-text search

## Registry Format

The registry at `notion-context/registry.yaml` maps projects to their Notion pages:

```yaml
projects:
  <project-key>:
    label: Human-readable name
    description: One-line project description
    dir: <directory-name>    # Maps to ~/Projects/<dir>/ for auto-detection from cwd
    hub: <page-id>           # Optional hub/parent page
    notes_db: <datasource-id> # Optional notes database
    pages:
      <slug>:
        id: <notion-page-id>
        name: Human-readable page title
        tags: [tag1, tag2]
```

## Cache Format

Each project gets one cache file at `notion-context/cache/<project>.yaml`:

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

## Steps by Action

### Status (empty input)

1. Read `notion-context/registry.yaml`
2. For each project, check if `notion-context/cache/<project>.yaml` exists
3. If cache exists, read it and check `last_sync` date
4. Report:

```
## Notion Context Registry

| Project | Pages | Last Sync | Status |
|---------|-------|-----------|--------|
| rebelsites | 15 | 2026-05-21 | Fresh (today) |
| agencyos | 3 | 2026-05-18 | Stale (3d ago) |
| taxloom | 0 | never | No cache |

Total: 18 pages across 3 projects
```

### Sync

1. Read `notion-context/registry.yaml` to get the target project(s) and their pages
2. For each page to sync:
   a. Fetch content: `ntn pages get <page-id>`
   b. **Summarize** the content into the cache format:
      - `summary`: 2-4 sentences capturing purpose and key content
      - `sections`: list of "Section: one-line summary" for each heading
      - `key_facts`: 5-10 most important specific facts (numbers, names, dates, decisions)
   c. Preserve the page's `tags` from the registry
3. Write the compiled cache file to `notion-context/cache/<project>.yaml`
4. Report what was synced and any pages that failed

**Summarization rules:**
- Be ruthlessly concise — these load into context and every token counts
- Prioritize specific facts over vague descriptions ("$49/mo pricing" not "competitive pricing")
- Include numbers, dates, names, and decisions — skip fluff
- If a page is very long, focus on sections that contain decisions, requirements, or specs
- Sections list should use the actual heading text from the document
- Max ~15 key_facts per page, aim for 5-10

### Add

1. Read registry
2. If `<page-id>` provided:
   a. Fetch the page: `ntn pages get <page-id>`
   b. Extract the title from frontmatter `Name` field
   c. Generate a slug from the name (lowercase, hyphens, no special chars)
   d. Ask user for tags (suggest based on content)
   e. Add to registry under the project
3. If no `<page-id>`:
   a. Ask user for the Notion page URL or ID
   b. Continue as above
4. Write updated registry
5. Offer to sync the newly added page

### Remove

1. Read registry
2. Find and remove the page entry for `<project>/<slug>`
3. Write updated registry
4. If cache exists, remove the page from the cache file too
5. Confirm removal

### Load

1. Read `notion-context/cache/<project>.yaml`
2. If no cache exists, suggest running `sync` first
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

### Discover

1. Use `mcp__claude_ai_Notion__notion-search` with the project name and related terms
2. Cross-reference results against already-registered pages
3. Show unregistered pages that look relevant:

```
## Discovered Notion Pages for <project>

Already registered: 15 pages
New candidates:
| Title | ID | Relevance |
|-------|-----|-----------|
| Marketing Budget Q2 | abc123... | pricing, marketing |
| Client Onboarding Flow | def456... | operations |

Add with: /notion-ctx add <project> <page-id>
```

### New

1. Read registry
2. Check if `~/Projects/<project>/` exists and set `dir` accordingly (null if no local directory)
3. Add a new empty project entry:
   ```yaml
   <project>:
     label: <ask user>
     description: <ask user>
     dir: <directory-name or null>
     pages: {}
   ```
4. Write updated registry
5. Suggest using `discover` or `add` to populate pages
6. To create a full Notion workspace (hub + Notes DB), use `/notion scaffold <project>`

### Review

1. Read `notion-context/cache/<project>.yaml`
2. For each page, display the cached summary and key facts
3. Ask user to confirm, edit, or flag as stale for each page
4. If user provides corrections, update the cache file directly
5. If flagged as stale, mark `stale: true` in the cache (sync will refresh)

## Rules

1. **Token efficiency is paramount** — summaries must be compact. A 5000-word Notion page should compress to ~200 tokens of cache.
2. **Fetch before summarize** — always read the actual Notion content, never guess.
3. **Registry is the source of truth** — cache can be rebuilt from registry + Notion at any time.
4. **Slug stability** — once a slug is assigned, don't change it. Other systems may reference it.
5. **Non-destructive sync** — sync overwrites cache but never modifies the registry. Add/remove modify the registry.
6. **Parallel fetching** — when syncing multiple pages, fetch them in parallel (up to 5 concurrent `ntn` calls).
7. **Date format** — always ISO-8601 (YYYY-MM-DD) in YAML files.
8. **Report failures gracefully** — if a page fetch fails (deleted, permissions), note it in the report but don't remove from registry.
9. **Prefer `ntn` CLI** over Notion MCP for page reads — it's faster and cheaper on tokens.
