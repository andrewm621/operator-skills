# project-health

One-shot health check for the current project. Delegates to specialized skills where possible and aggregates results.

Target directory: {the text you type after the command} (default: current working directory)

## Steps

1. **Detect project** — If `{the text you type after the command}` is provided, `cd` to that directory. Verify `package.json` exists. Detect package manager (pnpm-lock.yaml = pnpm, package-lock.json = npm).

2. **Run checks in parallel** — Use parallel bash calls for speed:

   **a) Security audit** (delegates to `/deps audit` logic):
   - `npm audit --json 2>/dev/null` or `pnpm audit --json 2>/dev/null`
   - Count: critical, high, moderate, low vulnerabilities

   **b) Outdated dependencies** (delegates to `/deps outdated` logic):
   - `npm outdated --json 2>/dev/null` or `pnpm outdated --json 2>/dev/null`
   - Categorize: major (breaking), minor, patch updates

   **c) Build check:**
   - Run `npm run build 2>&1` or `pnpm build 2>&1`
   - Capture exit code and any error output
   - Time the build

   **d) Lint check:**
   - Run `npm run lint 2>&1` or `pnpm lint 2>&1` (if lint script exists)
   - Count errors and warnings

   **e) Type check** (delegates to `/test` type-check logic):
   - Run `npx tsc --noEmit 2>&1`
   - Count type errors

3. **Additional checks** (fast, no subagent needed):
   - Lockfile freshness: does the lockfile exist and is it newer than package.json?
   - `.env.example` exists?
   - `.gitignore` includes `.env*.local`, `node_modules`, `.next`?
   - `CLAUDE.md` exists?

4. **Report** — Present a summary table:

   ```
   ## Project Health: <project-name>

   | Check | Status | Details |
   |-------|--------|---------|
   | Security audit | WARN | 2 moderate, 1 low vulnerability |
   | Outdated deps | INFO | 3 major, 8 minor, 5 patch |
   | Build | PASS | Clean build in 32s |
   | Lint | PASS | 0 errors, 4 warnings |
   | Types | FAIL | 3 type errors |
   | Lockfile | PASS | In sync |
   | Env template | PASS | .env.example exists |
   | Git ignore | WARN | Missing .env*.local pattern |
   | Project docs | PASS | CLAUDE.md exists |

   Overall: 6 pass, 2 warnings, 1 failure
   ```

5. **Suggest deeper investigation** — For each failure or warning, point to the right specialized skill:
   - Security issues → "Run `/deps audit` for details and fixes"
   - Outdated deps → "Run `/deps outdated` for categorized breakdown, `/deps update patch` for safe updates"
   - Type errors → "Run `/test` to investigate failures"
   - Build errors → "Run `/test` or check the error output above"
   - Env issues → "Run `/env-check` for full env comparison"
   - Database issues (if detected) → "Run `/db-status` for connection and migration check"
   - Git issues → "Run `/git-sync` for branch and sync status"

## Notes
- This is the "run everything and summarize" skill — it surfaces issues, specialized skills fix them
- The build step can be slow (30s-2min) — consider skipping with `/project-health --skip-build` argument
- This skill does NOT modify any files — it only reports
- For a narrower check, use the individual skills directly: `/deps`, `/test`, `/env-check`, `/db-status`
