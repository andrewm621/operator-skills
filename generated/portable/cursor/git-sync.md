# git-sync

Full git sync report for the current repository. Shows local vs remote status, all branches, uncommitted changes, stashes, and potential conflicts. Optional: pass a project directory as argument.

Target directory: {the text you type after the command} (default: current working directory)

## Steps

1. **Verify git repo** — If `{the text you type after the command}` is provided, `cd` to that directory first. Run `git rev-parse --show-toplevel` to confirm we're in a git repo. If not, tell the user and stop.

2. **Fetch latest from all remotes** — Run `git fetch --all --prune` to get the latest remote state without changing any local branches. This is safe and non-destructive.

3. **Current branch status** — Run these in parallel:
   - `git status --short --branch` — working tree summary
   - `git stash list` — any stashed changes
   - `git log --oneline -10` — recent local commits

4. **All branches report** — Run:
   ```
   git for-each-ref --format='%(refname:short) %(upstream:short) %(upstream:track) %(committerdate:relative)' refs/heads/
   ```
   This shows every local branch, its tracking remote, ahead/behind counts, and last commit date.

5. **Divergence details** — For each local branch that is ahead or behind its upstream:
   - If **behind**: `git log --oneline ..@{upstream}` (commits we're missing)
   - If **ahead**: `git log --oneline @{upstream}..` (commits not yet pushed)
   - If **diverged** (both ahead AND behind): show both, and flag this as needing attention

6. **Uncommitted changes detail** — If there are uncommitted changes:
   - `git diff --stat` — unstaged changes summary
   - `git diff --cached --stat` — staged changes summary
   - List any untracked files (from step 3)

7. **Conflict check** — For branches that have diverged from their upstream:
   - Run `git merge-tree $(git merge-base HEAD @{upstream}) HEAD @{upstream}` (or equivalent dry-run) to check for potential merge conflicts WITHOUT actually merging
   - If the current branch diverges from main/master, also check for conflicts against main

8. **Stale branches** — Identify local branches whose upstream has been deleted (gone) or that haven't been committed to in >30 days.

9. **Report** — Present a clear summary:

   ```
   ## Git Sync Report: <repo-name>

   ### Current Branch: <branch>
   Status: clean / dirty (N staged, M unstaged, K untracked)
   Upstream: <remote/branch> — up to date / N ahead / M behind / diverged

   ### All Branches
   | Branch | Upstream | Status | Last Commit |
   |--------|----------|--------|-------------|
   | main   | origin/main | up to date | 2h ago |
   | feature-x | origin/feature-x | 3 ahead | 1d ago |

   ### Action Items
   - [ ] Push: <branch> is N commits ahead
   - [ ] Pull: <branch> is M commits behind
   - [ ] Resolve: <branch> has diverged (N ahead, M behind)
   - [ ] Clean up: <branch> upstream is gone / stale (>30 days)
   - [ ] Stash: N stash entries found
   ```

10. **Offer actions** — Based on findings, offer to:
    - Pull branches that are behind (safe fast-forward only)
    - Push branches that are ahead
    - Delete stale/orphaned local branches
    - Pop or drop stashes

    **Do NOT take any action without asking first.** Just present the report and let the user decide.

## Notes
- This is a read-only report by default — no branches are modified
- `git fetch --all --prune` is the only write operation (updates remote tracking refs)
- For multi-remote setups, all remotes are fetched and reported
- Works from any subdirectory within a git repo
