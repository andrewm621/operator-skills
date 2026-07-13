# pr-review

Structured code review of a pull request. Checks security, logic, patterns, and breaking changes.

Arguments: {the text you type after the command} (PR number, branch name, or empty for current branch vs main)

## Steps

1. **Determine what to review** —
   - If `{the text you type after the command}` is a number: fetch PR diff with `gh pr diff {the text you type after the command}`
   - If `{the text you type after the command}` is a branch name: diff against main with `git diff main...{the text you type after the command}`
   - If empty: diff current branch against main with `git diff main...HEAD`
   - Also get the list of changed files: `git diff --name-only main...HEAD`

2. **Gather context** — Run in parallel:
   - `git diff --stat main...HEAD` — summary of changes (files, insertions, deletions)
   - `git log --oneline main...HEAD` — commits in the PR
   - Read all changed files fully (not just the diff) for complete context
   - If PR number given: `gh pr view {the text you type after the command} --json title,body,labels` for PR metadata

3. **Review categories** — Analyze the diff for each category:

   **a) Security (CRITICAL)**
   - SQL injection (raw queries with string interpolation)
   - XSS (unescaped user input rendered in JSX, unsafe innerHTML usage)
   - Auth bypass (missing middleware, unchecked roles)
   - Secret exposure (API keys, tokens in client code)
   - CSRF (missing token validation on mutations)
   - Insecure dependencies added

   **b) Logic & Correctness**
   - Race conditions (concurrent state updates, non-atomic DB operations)
   - Null/undefined handling (missing optional chaining, unchecked array access)
   - Error handling (swallowed errors, missing catch blocks)
   - Edge cases (empty arrays, zero values, boundary conditions)

   **c) Performance**
   - N+1 queries (loops with DB calls)
   - Missing React memoization where needed (expensive renders)
   - Large bundle imports (importing entire libraries)
   - Missing loading/error states

   **d) Patterns & Conventions**
   - Matches project conventions from CLAUDE.md
   - Component structure (function declarations, data-slot attributes)
   - Server vs client component boundaries
   - Proper use of Server Actions vs Route Handlers

   **e) Breaking Changes**
   - Database schema changes (new migrations)
   - API contract changes (route signatures, response shapes)
   - Environment variable additions/removals
   - Package version bumps (major versions)

4. **Report** — Present structured review:

   ```
   ## PR Review: #47 — Add event capacity limits
   Branch: feature/event-capacity → main
   Files changed: 8 | +245 / -32 | 5 commits

   ### Issues
   | Severity | File | Line | Issue |
   |----------|------|------|-------|
   | HIGH | api/events/route.ts | 45 | Race condition: check-and-decrement not atomic |
   | MEDIUM | components/event-card.tsx | 23 | Missing loading state for waitlist action |
   | LOW | lib/utils.ts | 12 | Unused import |

   ### Security: PASS
   No security issues found.

   ### Breaking Changes
   - New migration: `add_event_capacity` — must run before deploy
   - New env var: `WAITLIST_WEBHOOK_URL` — add to Vercel

   ### What looks good
   - Clean Server Action pattern for capacity mutation
   - Proper optimistic UI update with revalidation
   - Good error boundary around the waitlist form

   ### Recommendation: Request changes
   1 high-severity issue (race condition) should be fixed before merge.
   ```

5. **Offer actions** — Based on findings:
   - Post review as a GitHub PR comment (`gh pr review`)
   - Offer to fix issues found in code
   - **Never approve or merge without user instruction**

## Notes
- Requires `gh` CLI for PR-specific features (installed via `brew install gh`)
- Reading full file context (not just diff) is important for accurate reviews
- For large PRs (>20 files), focus on the most critical files first
- This skill does NOT modify code — it only reports findings
