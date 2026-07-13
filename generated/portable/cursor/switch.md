# switch

Fast context switch into any project with full orientation. Fuzzy matches project names against ~/Projects/*.

Target: {the text you type after the command}

## Steps

1. **Find the project** — If `{the text you type after the command}` is a full path, use it directly. Otherwise, fuzzy match against directory names in `~/Projects/`:
   - Run `ls ~/Projects/` and find the best match for `{the text you type after the command}` (case-insensitive, partial match OK)
   - If multiple matches, show them and ask the user to pick
   - If no match, tell the user and list similar names

2. **Enter the project** — `cd` into the matched directory.

3. **Read project context** — Check for and read these files (in parallel where possible):
   - `CLAUDE.md` or `.claude/CLAUDE.md` — project instructions
   - `package.json` — name, scripts, dependencies summary
   - Detect package manager: `pnpm-lock.yaml` = pnpm, `package-lock.json` = npm, `bun.lockb` = bun
   - Detect framework: `next.config.ts`/`next.config.js` = Next.js, `vite.config.ts` = Vite, `wrangler.toml` = Cloudflare

4. **Git status** — Run in parallel:
   - `git branch --show-current` — current branch
   - `git status --short` — clean or dirty (count staged/unstaged/untracked)
   - `git log --oneline -5` — last 5 commits

5. **Check for running dev server** — Run `lsof -ti :3000,3001,3002,3003,3004,3005` and check if any process is from this project directory.

6. **Report** — Present a concise orientation summary:

   ```
   ## Switched to: <project-name>
   <one-line description from CLAUDE.md or package.json if available>

   Stack: Next.js 16 + Neon + Drizzle | Package manager: pnpm
   Branch: main (clean) | Last commit: 2h ago — "fix: timezone handling"
   Dev server: running on :3001 (PID 12345) | not running

   Recent commits:
   - abc1234 fix: timezone handling (2h ago)
   - def5678 feat: add event capacity (1d ago)
   - ...
   ```

## Notes
- This skill changes the working directory — all subsequent commands will run in the new project
- If the project has a CLAUDE.md, its instructions apply for the rest of the session
- The user can type `/switch` without arguments to see a list of all projects
