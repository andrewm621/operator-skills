---
name: ship
description: >
  Drive a release end-to-end — pre-flight checks, verification gauntlet, version bump, changelog, tag, push, and deploy — with a single hard stop before anything irreversible.
argument-hint: "[patch|minor|major|<version>] (default: infer from commits)"
---

Drive a release end-to-end — pre-flight checks, verification gauntlet, version bump, changelog, tag, push, and deploy — with a single hard stop before anything irreversible.

Bump: $ARGUMENTS (optional: `patch`, `minor`, `major`, an explicit version like `2.1.0`, or empty to infer from commits)

This is the "Ship" in Build → Verify → Ship. It composes the verification skills (`/test`, `/changelog`) into one release path, and it never pushes, tags, or deploys without an explicit go.

## Steps

1. **Pre-flight gate (read-only)** — Establish that the repo is shippable before touching anything. Run in parallel:
   - **Clean tree** — `git status --porcelain`. Uncommitted changes? Stop and ask whether to commit them, stash them, or abort. Never ship a dirty tree silently.
   - **Branch & position** — `git rev-parse --abbrev-ref HEAD` and `git rev-list --left-right --count @{upstream}...HEAD 2>/dev/null`. If not on the release branch (usually `main`), confirm that's intended. If behind upstream, stop — pull first.
   - **Last release** — `git describe --tags --abbrev=0 2>/dev/null` for the current version, and `git log <tag>..HEAD --oneline` to see what's actually unreleased. If there are zero unreleased commits, stop: nothing to ship.
   - **Deploy target** — Detect how this project ships: `vercel.json` / `.vercel` → Vercel, `wrangler.toml` → Cloudflare Workers/Pages, `fly.toml` → Fly, `Dockerfile` + a registry, a `deploy`/`release` script in `package.json`, or a GitHub Actions release workflow. Note what you found — step 7 depends on it.

   If any gate fails, report exactly what blocked and stop. A failed pre-flight is a successful skill run — it caught the problem before the irreversible part.

2. **Run the verification gauntlet** — Don't ship red. Run the project's checks and require green:
   - Tests via `/test` (or the package.json `test` script directly).
   - Build (`npm run build` or the project's equivalent) — a release that doesn't build is the most common preventable incident.
   - Lint + type-check if the project has them (`tsc --noEmit`, `eslint`, `npm run typecheck`).

   Any failure stops the release. Report the failure with enough detail to act on, and offer to drop into a fix. Do not "ship anyway" on the user's behalf.

3. **Determine the version bump** — Resolve the new version number:
   - If `$ARGUMENTS` is an explicit version (`2.1.0`) or a keyword (`patch`/`minor`/`major`), use it.
   - If empty, **infer from conventional commits** since the last tag: any `BREAKING CHANGE`/`!` → **major**; any `feat:` → **minor**; otherwise → **patch**. For `0.x` projects, downgrade one level (a `feat:` on `0.x` is a patch-level bump by convention) and say so.
   - State the decision plainly: "12 commits since v1.4.2 — one `feat:`, no breaking changes → **minor** → v1.5.0." Let the user override.

4. **Generate the release notes** — Run `/changelog` for the range `<last-tag>..HEAD` to produce categorized notes. These become both the tag annotation and the GitHub release body. Keep them — don't regenerate later.

5. **Show the release plan and confirm — HARD STOP** — Present the full plan as one explicit confirmation. Everything before this was reversible; everything after is not. Lay it out:

   ```
   SHIP  my-app  v1.4.2 → v1.5.0

   Verify    tests 142✓ · build ✓ · types ✓
   Branch    main (up to date with origin)
   Commits   12 unreleased  →  minor bump
   Will do   1. bump package.json → 1.5.0
             2. commit "chore(release): v1.5.0"
             3. tag v1.5.0 (annotated, with changelog)
             4. push main + tag to origin
             5. deploy → Vercel (production)

   Release notes:
   ### Features
   - …
   ### Bug Fixes
   - …
   ```

   Wait for explicit go. Offer `--dry-run` semantics by default if the user only wanted the plan. If they want to ship the code but not deploy (tag-only), honor that — steps 6 and 7 are separable.

6. **Execute the release** — Only after the go. In order, stopping on any error:
   - Bump the version in `package.json` (and any lockfile / `Cargo.toml` / `pyproject.toml` / `manifest.json` the project uses — match what's actually there).
   - Commit: `chore(release): v<version>`.
   - Tag, annotated, with the changelog as the message: `git tag -a v<version> -m "<notes>"`.
   - Push with retry/backoff on network errors: `git push origin <branch> && git push origin v<version>`.

7. **Deploy** — Trigger the target detected in step 1:
   - **Vercel** — `vercel --prod` (or note that the git push already triggered a production deploy if the project auto-deploys on `main`; don't double-deploy).
   - **Cloudflare** — `wrangler deploy`.
   - **Fly** — `fly deploy`.
   - **GitHub release** — if the project releases via GitHub, create the release from the tag with the changelog body (confirm first — this is outward-facing and publishes).
   - **No clear target / unfamiliar infra** — stop and hand off: "Code is tagged and pushed as v1.5.0. Deploy is via `<thing>` — want me to run it, or will you?" Never guess at a deploy command that could hit production wrong.

8. **Verify and report** — After deploy, confirm it landed: poll the deployment status, or smoke-check the production URL with `/verify-app` if it's a web app. Then report:

   ```
   SHIPPED  v1.5.0
   Tag      pushed to origin
   Deploy   https://my-app.vercel.app  (200, version header v1.5.0)
   Rollback git revert <sha> && retag, or redeploy previous tag v1.4.2
   ```

   Always include the rollback path. The first question after a bad deploy is "how do I undo this" — answer it before it's asked.

## Notes
- **Confirmation is the whole point.** Steps 1–4 are read-only and autonomous. Step 5 is a hard stop. Pushing tags, creating GitHub releases, and deploying to production are irreversible and outward-facing — they always need an explicit go, even mid-flow.
- Composes with the quality skills: run `/invert <feature>` and `/pr-review` *before* `/ship` for anything risky — this skill verifies, it doesn't red-team. `/test` is invoked inline; `/changelog` produces the notes.
- **Monorepos** — detect whether you're shipping one package or the whole workspace. Per-package releases need per-package version bumps and tags (`pkg-name@1.5.0`); don't bump the root version for a leaf-package release.
- **Don't double-deploy.** Many setups auto-deploy on push to `main`. If so, the git push *is* the deploy — step 7 just verifies it, it doesn't re-trigger.
- If the project has no version file, no tags, and no deploy target, this skill isn't the right tool — that's a plain `git push`. Say so instead of inventing a release ceremony.
- For database changes riding along with the release, sequence `/migrate` deliberately relative to the deploy (expand-migrate-contract) — never fold a schema migration silently into a `/ship`.
