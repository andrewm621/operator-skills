Search across every project directory in your workspace for a pattern. Finds packages, code references, and files across 50+ projects.

Query: $ARGUMENTS

**Config:** `paths.projects` from `~/.config/operator-skills/config.yaml` (default `~/Projects`) — see `docs/config.md`. `<projects>` below is that directory (expand `~` before using it in Bash); a missing file or key means the default.

## Steps

1. **Classify the search** — Based on `$ARGUMENTS`, determine search mode:
   - If query looks like a package name (e.g., "stripe", "drizzle-orm", "@supabase/supabase-js", or a glob like "@supabase/*"): **package search**
   - If query looks like a filename or glob (e.g., "proxy.ts", "*.config.ts"): **file search**
   - Otherwise: **code search**
   - The user can also prefix: `pkg:stripe`, `file:proxy.ts`, `code:useSession`

2. **Execute search** — Based on mode:

   **Package search:**
   Strip a leading `pkg:` first (`QUERY="${QUERY#pkg:}"`), then match **exact dependency names** (a `grep` for `react` would also hit `react-dom`, `preact` and any description or script that mentions it). Look through every `package.json` up to four levels deep, so monorepo workspaces (`<projects>/app/packages/*/package.json`) are included, and skip `node_modules`/build output. A `*` in the query switches to glob matching (`@supabase/*`, `drizzle-*`); without one it is an exact name.
   ```bash
   QUERY="${QUERY#pkg:}"
   find <projects> -maxdepth 4 -name package.json \
     -not -path "*/node_modules/*" -not -path "*/.next/*" -not -path "*/dist/*" -not -path "*/.git/*" -print0 2>/dev/null |
   xargs -0 node -e '
     const fs = require("fs");
     const [q, ...files] = process.argv.slice(1);
     const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
     const re = q.includes("*") ? new RegExp("^" + q.split("*").map(esc).join(".*") + "$") : null;
     const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
     for (const f of files) {
       let pkg;
       try { pkg = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
       for (const field of fields)
         for (const [name, version] of Object.entries(pkg[field] || {}))
           if (re ? re.test(name) : name === q) console.log([f, name, version, field].join("\t"));
     }' "$QUERY"
   ```
   Each output row is `path<TAB>package<TAB>version<TAB>field`. The project is the first directory under `<projects>/`; `Dev?` is "yes" when the field is `devDependencies`, and note `peerDependencies` rows as peer. A project can match more than once (workspaces, or the same package in two fields) — keep every row, but count the project once.

   **File search:**
   ```bash
   # Find files matching the pattern across all projects
   find <projects> -maxdepth 4 -name "$QUERY" -not -path "*/node_modules/*" -not -path "*/.next/*" -not -path "*/dist/*" -not -path "*/.git/*" 2>/dev/null
   ```

   **Code search:**
   ```bash
   # Search source files for the pattern
   grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.sql" "$QUERY" <projects>/ --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist --exclude-dir=.git -l 2>/dev/null | head -30
   ```
   Then get match counts per project: `grep -c` for each matched file.

3. **Group results by project** — Parse file paths to extract the project name (first directory under `<projects>/`). Sort by match count descending.

4. **Get context** — For code searches, show a few sample matches (with line numbers) from the top projects.

5. **Report** — Present grouped results:

   **For package searches:**
   ```
   ## Search: package "stripe" across <projects>

   Found in 6 projects:
   | Project | Package | Version | Dev? |
   |---------|---------|---------|------|
   | dashboard | stripe | ^14.2.0 | no |
   | community-app | stripe | ^14.1.0 | no |
   | billing-app | stripe | ^14.2.0 | no |
   | web-app | stripe | ^13.9.0 | no |
   | api-service | stripe | ^14.0.0 | no |
   | admin-portal | stripe | ^14.2.0 | no |

   Note: web-app is on an older version (13.9.0 vs 14.2.0)
   ```

   **For code searches:**
   ```
   ## Search: "useSession" across <projects>

   Found in 4 projects (23 total matches):
   | Project | Matches | Key files |
   |---------|---------|-----------|
   | dashboard | 8 | lib/auth.ts, components/nav.tsx |
   | web-app | 7 | lib/session.ts, app/layout.tsx |
   | community-app | 5 | hooks/use-auth.ts |
   | api-service | 3 | lib/auth.ts |

   Sample (dashboard/lib/auth.ts:15):
     const { data: session } = useSession()
   ```

   **For file searches:**
   ```
   ## Search: file "proxy.ts" across <projects>

   Found in 3 projects:
   - dashboard/proxy.ts (2.1KB, modified 2d ago)
   - web-app/src/proxy.ts (1.8KB, modified 1w ago)
   - community-app/proxy.ts (950B, modified 3d ago)
   ```

## Notes
- Excludes: node_modules, .next, dist, .git, build directories
- Limits results to first 30 matching files for performance
- For deeper investigation of a specific project's matches, suggest using Grep directly in that project
- This is a read-only search — no files are modified
