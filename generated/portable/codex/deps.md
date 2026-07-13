Dependency management across projects. Audit vulnerabilities, update packages, and align versions across the workspace.

Arguments: $ARGUMENTS (subcommand: "audit", "update", "align", "check <package>", "outdated", or a package name to investigate)

## Steps

1. **Parse the subcommand** — From `$ARGUMENTS`:

   | Input | Action |
   |-------|--------|
   | _(empty)_ or `outdated` | Show outdated deps for current project |
   | `audit` | Security vulnerability scan |
   | `update [scope]` | Update packages (patch, minor, or major) |
   | `align <package>` | Align a package version across all projects |
   | `check <package>` | Show where a package is used across all projects |
   | A package name (e.g., "stripe") | Same as `check` |

2. **Detect project context:**
   - Read `package.json` for current dependencies
   - Detect package manager: `pnpm-lock.yaml` = pnpm, `package-lock.json` = npm
   - Check if monorepo: `turbo.json`, `pnpm-workspace.yaml`, `workspaces` in package.json

3. **Execute based on subcommand:**

   ### `outdated` (default)
   ```bash
   npm outdated --json 2>/dev/null || pnpm outdated --json 2>/dev/null
   ```

   Categorize and present:
   ```
    DEPS OUTDATED  <project-name>

    ### Major Updates (breaking — review changelogs)
    | Package | Current | Latest | Type |
    |---------|---------|--------|------|
    | stripe | 13.9.0 | 14.2.0 | dep |
    | drizzle-orm | 0.36.0 | 0.38.1 | dep |

    ### Minor Updates (features — generally safe)
    | Package | Current | Latest | Type |
    |---------|---------|--------|------|
    | @clerk/nextjs | 5.2.1 | 5.4.0 | dep |
    | zod | 3.22.0 | 3.23.8 | dep |

    ### Patch Updates (fixes — safe to apply)
    | Package | Current | Latest | Type |
    |---------|---------|--------|------|
    | lucide-react | 0.395.0 | 0.395.3 | dep |

    Summary: 2 major, 2 minor, 1 patch outdated
    Run: /deps update patch (safe) | /deps update minor | /deps update major stripe
   ```

   ### `audit`
   ```bash
   npm audit --json 2>/dev/null || pnpm audit --json 2>/dev/null
   ```

   Parse and present:
   ```
    DEPS AUDIT  <project-name>

    | Severity | Count | Packages |
    |----------|-------|----------|
    | Critical | 0 | — |
    | High | 1 | nth-check (via postcss-svgo) |
    | Moderate | 2 | semver, word-wrap |
    | Low | 1 | debug |

    ### High Severity
    **nth-check** (<5.0.0) — Inefficient regex in nth-check
    Path: postcss-svgo > postcss-svgo > svgo > css-select > nth-check
    Fix: npm audit fix (auto-fixable)

    ### Recommendations
    - Run `npm audit fix` to auto-fix 3 of 4 vulnerabilities
    - 1 requires manual update: `npm install postcss-svgo@latest`
   ```

   ### `update [scope]`
   Parse scope from arguments:
   - `update patch` — update all patch versions (safe)
   - `update minor` — update all minor versions (generally safe)
   - `update major <package>` — update a specific package to next major
   - `update all` — update everything (risky)
   - `update` (no scope) — default to `patch`

   **a) Show what will change:**
   ```bash
   # Dry run first
   npm outdated --json 2>/dev/null
   ```
   Filter to the requested scope and present:
   ```
    DEPS UPDATE  Updating 5 patch dependencies

    | Package | From | To |
    |---------|------|----|
    | lucide-react | 0.395.0 | 0.395.3 |
    | @types/node | 20.14.0 | 20.14.2 |
    | ... | ... | ... |

    Proceed? (y/N)
   ```

   **b) Apply updates (after confirmation):**
   ```bash
   # For patch: update lockfile
   npm update 2>&1

   # For specific major: install explicitly
   npm install stripe@latest 2>&1
   ```

   **c) Verify after updating:**
   - Run `npx tsc --noEmit` to check for type breaks
   - Run `npm run build` if a major version was updated
   - Report results:
   ```
    UPDATE COMPLETE  5 packages updated

    Type check: PASS
    Build: PASS (or FAIL with details)

    Note: Run tests with /test to verify runtime behavior
   ```

   **For major updates**, read the changelog/migration guide:
   - Attempt to fetch the package's CHANGELOG.md from the repo
   - Highlight breaking changes that affect the project
   - If the update breaks types or build, offer to fix the issues

   ### `align <package>`
   **a) Find all projects using the package:**
   ```bash
   grep -rl "\"<package>\"" ~/Projects/*/package.json 2>/dev/null
   ```

   **b) Extract versions:**
   For each matching `package.json`, read the version of the target package.

   **c) Report:**
   ```
    DEPS ALIGN  stripe across ~/Projects

    | Project | Version | Status |
    |---------|---------|--------|
    | agencyos | ^14.2.0 | latest |
    | communityos | ^14.1.0 | minor behind |
    | pay-copilot | ^14.2.0 | latest |
    | liberty-networking | ^13.9.0 | MAJOR behind |
    | strata | ^14.2.0 | latest |

    Latest: 14.2.0
    Behind: 2 projects (communityos: minor, liberty-networking: major)

    Options:
    1. Update all to ^14.2.0 (spawns parallel agents per project)
    2. Update only minor-behind projects (safe)
    3. Show changelog for 13.9.0 → 14.2.0
   ```

   **d) If the user chooses to align:**
   - Spawn parallel agents (via the Agent tool) for each project needing updates
   - Each agent: cd into project → `npm install <package>@latest` → type check → build
   - Aggregate results like `/parallel-check`

   ### `check <package>`
   Same as `align` but read-only — just show where it's used and what versions. No update offers unless the user asks.

   Add extra detail:
   - Which files import from the package (top 5 per project)
   - Whether it's a dep or devDep
   - Last time it was updated in each project (from git log)

## Notes
- **Never update packages without showing what will change and getting confirmation**
- For monorepos, `pnpm update` at the workspace root updates all packages — warn about this scope
- Major version updates should always be followed by type check + build + test
- The `align` subcommand is the cross-project killer feature — it prevents version drift across 50+ projects
- For @rebel/ui changes, prefer `/parallel-check` which also tests the build, not just the version
- If `npm audit` reports vulnerabilities in devDeps only, note that these don't affect production
- This skill pairs with `/search-all pkg:<name>` for quick lookups; `/deps` adds analysis and actions on top
