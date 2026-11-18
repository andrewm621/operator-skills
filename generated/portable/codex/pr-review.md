Structured code review of a pull request. Checks security, logic, patterns, and breaking changes.

Arguments: $ARGUMENTS (PR number, branch name, or empty for current branch vs the default branch)

## Steps

1. **Determine what to review** — Resolve the base branch and the diff range first; every later step reuses them. Never assume the base is `main`.
   - **Default branch** (`DEFAULT`): `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`; without `gh`, `git symbolic-ref --short refs/remotes/origin/HEAD` (strip the `origin/`); if both fail, whichever of `main` / `master` exists
   - If `$ARGUMENTS` is a number (PR): `gh pr view $ARGUMENTS --json title,body,labels,baseRefName,headRefName,files,commits`. Base = `baseRefName`, head = `headRefName`. Diff with `gh pr diff $ARGUMENTS`. Changed files come from the `files` JSON. To read files in full without touching the working tree, run `git fetch origin pull/$ARGUMENTS/head` and use `git show FETCH_HEAD:<path>` (or read them directly if the PR branch is already checked out)
   - If `$ARGUMENTS` is a branch name: base = `DEFAULT`, head = that branch. Range = `<base>...<branch>`. If the branch only exists on the remote, use `origin/<branch>`
   - If empty: base = `DEFAULT`, head = current branch (`git branch --show-current`). Range = `<base>...HEAD`. If the current branch *is* the default branch (or the range is empty), say there is nothing to review and ask for a PR number or branch
   - Prefer `origin/<base>` over the local `<base>` when it exists, since a stale local base inflates the diff
   - For branch/empty modes: diff with `git diff <range>`, changed files with `git diff --name-only <range>`

2. **Gather context** — Run in parallel:
   - `git diff --stat <range>` — summary of changes (files, insertions, deletions). For a PR number, use the `files` JSON (`additions`/`deletions`) instead
   - `git log --oneline <range>` — commits in the PR. For a PR number, use the `commits` JSON
   - Read all changed files fully (not just the diff) for complete context
   - PR metadata (title, body, labels) comes from the `gh pr view` call in step 1 when a PR number was given

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
   Branch: feature/event-capacity → <base>
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
