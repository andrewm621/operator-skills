Check if a shared dependency change breaks consumer projects. Thin wrapper around `/parallel build-check` with auto-detected consumers.

Arguments: $ARGUMENTS (optional: specific projects to check, or "all" for all consumers)

## Steps

1. **Detect what changed and find consumers:**

   **If in `~/Projects/design-system/`** (most common case):
   - Auto-detect @rebel/ui consumers:
     ```bash
     grep -rl '"@rebel/ui"' ~/Projects/*/package.json 2>/dev/null
     ```
   - Known consumers from CLAUDE.md: agencyos, communityos, liberty-networking, helloconnect, formflow, document_engine, serviceos
   - If `$ARGUMENTS` specifies projects, use those instead of auto-detecting
   - If `$ARGUMENTS` is "all", check every consumer found

   **If in a Turborepo `packages/` directory:**
   - Check `turbo.json` and `package.json` workspace references to find dependents

   **Otherwise:**
   - Ask what was changed and which consumers to check

2. **Ensure the shared package is built:**
   - If in design-system: verify `pnpm build` has been run (check dist/ freshness)
   - If dist/ is stale, run the build first

3. **Delegate to `/parallel build-check`** — Construct the equivalent `/parallel` command and execute it:

   This is functionally the same as running:
   ```
   /parallel build-check <consumer1> <consumer2> <consumer3> ...
   ```

   For each consumer project, spawn a parallel subagent that:
   - `cd`s into the project directory
   - Runs `npm install` or `pnpm install` (to pick up the linked changes)
   - Runs `npx tsc --noEmit` (type check)
   - Runs `npm run build` (build check)
   - Reports: pass/fail with error details

   **IMPORTANT:** Spawn all subagents in parallel — don't wait for one to finish before starting the next.

4. **Collect and report results:**

   ```
   ## Parallel Check: @rebel/ui change

   Checked N consumer projects:

   | Project | Types | Build | Status |
   |---------|-------|-------|--------|
   | agencyos | PASS | PASS | OK |
   | liberty-networking | PASS | PASS | OK |
   | communityos | FAIL | - | Blocked |
   | helloconnect | PASS | PASS | OK |

   ### Failures
   **communityos** — Type error:
   src/components/nav.tsx:23 — Property 'variant' does not exist on type 'ButtonProps'

   ### Action Items
   - [ ] Fix communityos/src/components/nav.tsx — update prop name
   ```

5. **Offer fixes** — For each failure:
   - Show the specific error and which change caused it
   - Offer to fix it directly (open the file, make the change)
   - After fixing, offer to re-run the check for that project

## Notes
- This is a convenience wrapper — it auto-detects consumers and delegates to parallel build agents
- For general-purpose parallel checks (not @rebel/ui), use `/parallel build-check <projects>` directly
- Builds can take 30s-2min per project — parallel execution saves significant time
- Does NOT push or commit changes — only builds and type-checks locally
