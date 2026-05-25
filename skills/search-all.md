Search across all ~/Projects/* directories for a pattern. Finds packages, code references, and files across 50+ projects.

Query: $ARGUMENTS

## Steps

1. **Classify the search** — Based on `$ARGUMENTS`, determine search mode:
   - If query looks like a package name (e.g., "stripe", "drizzle-orm", "@supabase/supabase-js"): **package search**
   - If query looks like a filename or glob (e.g., "proxy.ts", "*.config.ts"): **file search**
   - Otherwise: **code search**
   - The user can also prefix: `pkg:stripe`, `file:proxy.ts`, `code:useSession`

2. **Execute search** — Based on mode:

   **Package search:**
   ```bash
   # Search all package.json files for the dependency
   grep -rl "$QUERY" ~/Projects/*/package.json 2>/dev/null | head -20
   ```
   Then for each match, extract the package version from the package.json.

   **File search:**
   ```bash
   # Find files matching the pattern across all projects
   find ~/Projects -maxdepth 4 -name "$QUERY" -not -path "*/node_modules/*" -not -path "*/.next/*" -not -path "*/dist/*" -not -path "*/.git/*" 2>/dev/null
   ```

   **Code search:**
   ```bash
   # Search source files for the pattern
   grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.sql" "$QUERY" ~/Projects/ --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=.git -l 2>/dev/null | head -30
   ```
   Then get match counts per project: `grep -c` for each matched file.

3. **Group results by project** — Parse file paths to extract the project name (first directory under `~/Projects/`). Sort by match count descending.

4. **Get context** — For code searches, show a few sample matches (with line numbers) from the top projects.

5. **Report** — Present grouped results:

   **For package searches:**
   ```
   ## Search: package "stripe" across ~/Projects

   Found in 6 projects:
   | Project | Package | Version | Dev? |
   |---------|---------|---------|------|
   | agencyos | stripe | ^14.2.0 | no |
   | communityos | stripe | ^14.1.0 | no |
   | pay-copilot | stripe | ^14.2.0 | no |
   | liberty-networking | stripe | ^13.9.0 | no |
   | helloconnect | stripe | ^14.0.0 | no |
   | strata | stripe | ^14.2.0 | no |

   Note: liberty-networking is on an older version (13.9.0 vs 14.2.0)
   ```

   **For code searches:**
   ```
   ## Search: "useSession" across ~/Projects

   Found in 4 projects (23 total matches):
   | Project | Matches | Key files |
   |---------|---------|-----------|
   | agencyos | 8 | lib/auth.ts, components/nav.tsx |
   | liberty-networking | 7 | lib/session.ts, app/layout.tsx |
   | communityos | 5 | hooks/use-auth.ts |
   | helloconnect | 3 | lib/auth.ts |

   Sample (agencyos/lib/auth.ts:15):
     const { data: session } = useSession()
   ```

   **For file searches:**
   ```
   ## Search: file "proxy.ts" across ~/Projects

   Found in 3 projects:
   - agencyos/proxy.ts (2.1KB, modified 2d ago)
   - liberty-networking/src/proxy.ts (1.8KB, modified 1w ago)
   - communityos/proxy.ts (950B, modified 3d ago)
   ```

## Notes
- Excludes: node_modules, .next, dist, .git, build directories
- Limits results to first 30 matching files for performance
- For deeper investigation of a specific project's matches, suggest using Grep directly in that project
- This is a read-only search — no files are modified
