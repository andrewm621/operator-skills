# test

Run and analyze tests for the current project. Detects test framework, runs targeted or full suites, and reports results with actionable fix suggestions.

Arguments: {the text you type after the command} (optional: file path, test name pattern, "watch", "coverage", or "failing")

## Steps

1. **Detect test setup** — Check for test framework and configuration (in parallel):

   **a) Framework detection:**
   - `vitest.config.ts` or `vitest` in package.json → Vitest
   - `jest.config.ts` or `jest.config.js` or `jest` in package.json → Jest
   - `playwright.config.ts` → Playwright (e2e)
   - `cypress.config.ts` → Cypress (e2e)
   - Check `package.json` scripts for `test`, `test:unit`, `test:e2e`, `test:integration`

   **b) Test file inventory:**
   - Find test files: `**/*.test.{ts,tsx}`, `**/*.spec.{ts,tsx}`, `**/__tests__/**`
   - Count by directory/category: unit, integration, e2e, component
   - If no test files found, report that and suggest: "No tests found. Want me to scaffold test setup for this project?"

   **c) Recent changes:** (for smart targeting)
   - `git diff --name-only HEAD~5` — recently changed source files
   - Map changed source files to their corresponding test files (e.g., `lib/auth.ts` → `lib/__tests__/auth.test.ts` or `lib/auth.test.ts`)

2. **Determine what to run** — Based on `{the text you type after the command}`:

   | Input | Action |
   |-------|--------|
   | _(empty)_ | Run full test suite via package.json `test` script |
   | A file path | Run tests for that specific file |
   | A pattern (e.g., "auth", "stripe") | Run tests matching the pattern (`--grep` or `-t`) |
   | `failing` | Re-run only previously failed tests (`--failed` or `--onlyFailures`) |
   | `watch` | Start test watcher |
   | `coverage` | Run with coverage reporting |
   | `changed` | Run tests related to uncommitted changes |
   | `scaffold` | Create test setup (jump to Step 6) |

3. **Run the tests** — Execute with appropriate flags:

   **Vitest:**
   ```bash
   # Full suite
   npx vitest run 2>&1
   # Specific file
   npx vitest run <file> 2>&1
   # Pattern match
   npx vitest run -t "<pattern>" 2>&1
   # Coverage
   npx vitest run --coverage 2>&1
   # Changed files only
   npx vitest run --changed 2>&1
   ```

   **Jest:**
   ```bash
   # Full suite
   npx jest --no-cache 2>&1
   # Specific file
   npx jest <file> 2>&1
   # Pattern match
   npx jest -t "<pattern>" 2>&1
   # Coverage
   npx jest --coverage 2>&1
   # Only failures
   npx jest --onlyFailures 2>&1
   # Related to changes
   npx jest --changedSince=HEAD~5 2>&1
   ```

   **Playwright:**
   ```bash
   npx playwright test 2>&1
   npx playwright test <file> 2>&1
   npx playwright test --grep "<pattern>" 2>&1
   ```

   Capture stdout, stderr, and exit code. Time the execution.

4. **Parse results** — Extract from output:
   - Total tests: passed, failed, skipped, pending
   - Per-file breakdown for failures
   - For each failure: test name, file:line, error message, expected vs received
   - Duration per suite

5. **Report** — Present results:

   ```
   ## Test Results: <project-name>
   Framework: Vitest | Duration: 4.2s

   | Suite | Passed | Failed | Skipped | Duration |
   |-------|--------|--------|---------|----------|
   | lib/auth.test.ts | 5 | 1 | 0 | 0.8s |
   | lib/stripe.test.ts | 8 | 0 | 0 | 1.2s |
   | components/nav.test.tsx | 3 | 0 | 2 | 0.4s |

   Overall: 16 passed, 1 failed, 2 skipped (84% pass rate)

   ### Failures
   **lib/auth.test.ts:45** — "should reject expired tokens"
   Expected: `{ valid: false, reason: "expired" }`
   Received: `{ valid: false, reason: "invalid_signature" }`

   The token validation function is returning "invalid_signature" instead of
   "expired" for tokens past their expiration. Check the validation order in
   `lib/auth.ts:validateToken()` — expiry should be checked before signature.

   ### Coverage (if requested)
   | File | Stmts | Branch | Funcs | Lines |
   |------|-------|--------|-------|-------|
   | lib/auth.ts | 82% | 65% | 90% | 82% |
   | lib/stripe.ts | 95% | 88% | 100% | 95% |
   ```

   **For each failure, provide:**
   - The specific error with expected/received values
   - A brief analysis of the likely cause (read the source file if needed)
   - Offer to fix it

6. **Scaffold test setup** — If `{the text you type after the command}` is "scaffold" or no tests exist:

   **a) Ask which framework:**
   - Vitest (recommended for Vite and Next.js projects)
   - Jest (if already using Jest ecosystem)
   - Playwright (for e2e)

   **b) Install dependencies:**
   - Vitest: `vitest @testing-library/react @testing-library/jest-dom`
   - Add `test` script to package.json
   - Create config file with sensible defaults

   **c) Create example test:**
   - Pick a simple utility or component from the project
   - Write a basic test as a template for the user to follow

## Notes
- Default behavior (no args) runs the `test` script from package.json — this respects whatever the project has configured
- For failures, reading the source file before suggesting fixes leads to much better analysis
- `watch` mode keeps running in the terminal — warn the user that it's interactive
- Coverage reports can be slow on large projects — mention that if `coverage` is requested
- For monorepos, detect if we're in a workspace root (run all) or a specific package (run scoped)
- This skill pairs with `/pr-review` — run tests before review to catch issues early
- If the project has both unit and e2e tests, mention both options and default to unit tests
