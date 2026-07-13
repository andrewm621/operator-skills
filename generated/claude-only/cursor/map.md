# map

Generate or update an architectural map of a project — folder structure, dependencies, data flow, and component relationships — with Mermaid diagrams.

Target: {the text you type after the command} (project name, directory, or "workspace" for the full ~/Projects overview)

## Steps

1. **Determine scope** — From `{the text you type after the command}`:

   - If a project name is given (e.g., "agencyos", "liberty-networking"), resolve to `~/Projects/<dir>`
   - If "workspace" or "all", map the full `~/Projects/` workspace at a high level
   - If empty, use the current working directory
   - If a subdirectory path is given (e.g., "app/api"), map just that subtree in detail

2. **Explore the project** — Spawn an Explore subagent (or do directly for small projects) to gather:

   **a) Structure:**
   - Run `find <dir> -type f -name "*.ts" -o -name "*.tsx" -o -name "*.py" -o -name "*.json" | head -200` to understand the file tree
   - Read `package.json` (dependencies, scripts, workspaces)
   - Read `CLAUDE.md` if it exists
   - Check for monorepo indicators: `turbo.json`, `pnpm-workspace.yaml`, workspace `packages/`
   - Read `next.config.ts`, `vite.config.ts`, `wrangler.toml`, `drizzle.config.ts` as applicable

   **b) Architecture:**
   - Identify the framework and routing structure (App Router pages, API routes, etc.)
   - Find database schema files (`schema.ts`, `migrations/`)
   - Find auth configuration (middleware, proxy.ts, auth providers)
   - Identify key entry points and their relationships
   - Find shared utilities, hooks, components directories

   **c) Dependencies:**
   - Parse `package.json` for key external deps (not devDeps boilerplate)
   - For monorepos: map inter-package dependencies
   - For `@rebel/ui` consumers: note the design system link

3. **Generate the architectural map** — Produce a comprehensive markdown document with Mermaid diagrams:

   **a) Project Overview header:**
   ```markdown
   # Architecture: <Project Name>
   Generated: YYYY-MM-DD | Framework: Next.js 16 | DB: Neon + Drizzle | Auth: Clerk

   ## Quick Stats
   - **Files:** ~N TypeScript files across M directories
   - **Routes:** N pages, M API routes
   - **Database:** N tables
   - **Key deps:** list of 5-8 major dependencies
   ```

   **b) Folder Structure diagram** — Mermaid `graph TD` showing the directory tree with annotations:
   ```markdown
   ## Folder Structure

   ```mermaid
   graph TD
       ROOT["agencyos/"] --> APP["app/"]
       ROOT --> LIB["lib/"]
       ROOT --> COMP["components/"]
       ROOT --> DB["db/"]

       APP --> PAGES["(pages)"]
       APP --> API["api/"]
       APP --> LAYOUTS["layout.tsx"]

       PAGES --> DASH["dashboard/"]
       PAGES --> AUTH["auth/"]
       PAGES --> SETTINGS["settings/"]

       API --> WEBHOOKS["webhooks/"]
       API --> TRPC["trpc/"]

       LIB --> ACTIONS["actions/"]
       LIB --> UTILS["utils/"]
       LIB --> HOOKS["hooks/"]

       DB --> SCHEMA["schema.ts"]
       DB --> MIGRATIONS["migrations/"]

       COMP --> UI["ui/ (shadcn)"]
       COMP --> FEATURES["feature components"]

       style ROOT fill:#1e1e2e,color:#cdd6f4
       style APP fill:#313244,color:#cdd6f4
       style DB fill:#45475a,color:#cdd6f4
   ```
   ```

   **c) Data Flow diagram** — Mermaid `flowchart LR` showing how data moves through the system:
   ```markdown
   ## Data Flow

   ```mermaid
   flowchart LR
       CLIENT["Browser"] -->|"Server Components"| RSC["Next.js RSC"]
       CLIENT -->|"Client Actions"| SA["Server Actions"]
       SA -->|"Drizzle ORM"| DB[(Neon Postgres)]
       RSC -->|"Drizzle ORM"| DB
       API["API Routes"] -->|"Drizzle ORM"| DB
       WEBHOOK["Stripe Webhooks"] --> API
       CRON["Cron Jobs"] --> API
       SA -->|"revalidatePath"| RSC
   ```
   ```

   **d) Dependency graph** — For monorepos, show inter-package relationships:
   ```markdown
   ## Package Dependencies

   ```mermaid
   graph TD
       APP["@app/web"] --> SHARED["@app/shared"]
       APP --> UI["@rebel/ui"]
       APP --> DB["@app/db"]
       API["@app/api"] --> SHARED
       API --> DB
       DB --> DRIZZLE["drizzle-orm"]
       DB --> NEON["@neondatabase/serverless"]
   ```
   ```

   **e) Component Architecture** — For frontend-heavy projects, show component hierarchy:
   ```markdown
   ## Component Architecture

   ```mermaid
   graph TD
       LAYOUT["RootLayout"] --> NAV["Navbar"]
       LAYOUT --> SIDEBAR["Sidebar"]
       LAYOUT --> MAIN["Main Content"]

       MAIN --> DASHBOARD["DashboardPage"]
       DASHBOARD --> STATS["StatsCards"]
       DASHBOARD --> TABLE["DataTable"]
       DASHBOARD --> CHARTS["Charts"]

       TABLE --> DIALOG["EditDialog"]
       TABLE --> ACTIONS["RowActions"]

       NAV --> AVATAR["UserAvatar"]
       NAV --> THEME["ThemeToggle"]
   ```
   ```

   **f) Auth & Middleware flow** — If auth exists, show the request lifecycle:
   ```markdown
   ## Auth Flow

   ```mermaid
   sequenceDiagram
       participant Browser
       participant Proxy as proxy.ts
       participant Clerk
       participant App as Server Component
       participant DB as Neon

       Browser->>Proxy: Request /dashboard
       Proxy->>Clerk: Verify session
       Clerk-->>Proxy: User authenticated
       Proxy->>App: Forward with auth context
       App->>DB: Query user data
       DB-->>App: Results
       App-->>Browser: Rendered page
   ```
   ```

   **g) Database Schema** — If schema files exist, show table relationships:
   ```markdown
   ## Database Schema

   ```mermaid
   erDiagram
       users ||--o{ projects : "owns"
       users ||--o{ invoices : "receives"
       projects ||--o{ tasks : "contains"
       projects }o--|| clients : "belongs to"
       invoices }o--|| projects : "for"
   ```
   ```

   **IMPORTANT:** Only include diagram types that are relevant. A simple app doesn't need all 7 diagrams. A CLI tool might only need folder structure + data flow. A monorepo needs the dependency graph. Use judgment.

4. **Save the map** — Write to the appropriate location:

   **For individual projects:**
   - Save to `<project-dir>/ARCHITECTURE.md` (lives with the code, git-trackable)
   - If the project has a CLAUDE.md, add a brief mention: "See ARCHITECTURE.md for visual diagrams"

   **For workspace-level maps:**
   - Save to `~/.claude/projects/-Users-andrewmiller-Projects/memory/workspace_architecture.md`

   **For updating an existing map:**
   - Read the existing file first
   - Update only the sections that have changed
   - Update the "Generated" date

5. **Update the knowledge map** — If this is a new project being mapped for the first time:
   - Check if it exists in `memory/project_knowledge_map.md`
   - If not, add it to the appropriate category
   - If the project has enough complexity, suggest creating a dedicated `memory/project_<name>.md`

6. **Present the results** — Display the complete architecture map. Since Mermaid renders in markdown viewers, also offer:
   - "View in GitHub/VS Code for rendered diagrams"
   - "Run `/document architecture notion` to create a Notion page with these diagrams"

## Diagram Guidelines

**Mermaid best practices for these maps:**
- Use descriptive node IDs in CAPS: `DB["Neon Postgres"]` not just `DB`
- Add edge labels for relationships: `-->|"Drizzle ORM"|`
- Use subgraphs to group related nodes when there are 10+ nodes
- Keep diagrams under 20 nodes each — split into multiple diagrams rather than one giant one
- Use consistent styling: dark theme colors (`#1e1e2e`, `#313244`, `#45475a`, `#585b70` for backgrounds, `#cdd6f4` for text)
- For sequence diagrams, show the happy path first, then note error cases
- For ER diagrams, focus on the core tables (skip audit/log tables unless relevant)

**Which diagram types to use:**
| Project Type | Recommended Diagrams |
|-------------|---------------------|
| Next.js full-stack | Folder structure, Data flow, Auth flow, DB schema |
| Monorepo | All of the above + Package dependencies |
| API/Backend only | Folder structure, Data flow, DB schema |
| CLI/SDK | Folder structure, Data flow |
| Design system | Folder structure, Component architecture |
| Workspace overview | High-level dependency graph between projects |

## Notes
- This skill generates ARCHITECTURE.md files that live alongside the code — they're documentation, not ephemeral
- For large projects (100+ files), spawn an Explore agent to gather the structure rather than doing it inline
- Mermaid diagrams render natively in GitHub, VS Code preview, Notion, and most markdown viewers
- When updating an existing map, diff against the current code to catch new routes, tables, or packages
- The workspace-level map (`/map workspace`) shows how projects relate to each other — shared deps, design system consumers, deployment targets
- If a project uses @rebel/ui, always show it in the dependency graph
- For AI projects, include the model/provider flow (which AI SDK, which models, tool calling patterns)
