---
name: walkthrough
description: >
  Turn a real app, or a described flow, into a self-contained auto-playing guided walkthrough page (60-90 seconds, 5-8 scenes, captions, a moving cursor, player controls, a step list). Storyboards first and waits for approval, checks for real people's data, QAs headlessly in light, dark and phone, then publishes a private artifact and, only on an explicit yes, a public Cloudflare link.
argument-hint: "<app or flow> [--from <repo path>] [--shots] [--public] [--export mp4|gif] | refresh <slug> | status"
---

Build, refresh or audit a guided walkthrough page of an app: it plays itself, shows a cursor doing the job, and explains each step in a caption band.

Task: $ARGUMENTS

A walkthrough is **a replica of the app's UI driven by a timeline**, not a screen recording. Every frame is a pure function of time `t` (the rule `/motion-artifact` is built on), so the page plays, scrubs, jumps and exports the same way. It runs in a private Claude artifact and, if asked, on a public noindex Cloudflare Workers page.

Modes: `<app or flow>` builds one. `refresh <slug>` re-shoots only the scenes the app has outgrown. `status` lists the project's walkthroughs and how stale each is. `--shots` means annotated screenshots instead of mirrored code (use it when there is no code). `--public` and `--export` are asked for up front but still wait for their own gates below.

## Where things live

The template, scripts and fixture sit next to this skill in the operator-skills repo (`skills/walkthrough/`). It also needs the sibling `skills/motion-artifact/`; the scripts find it themselves (override with `MOTION_ARTIFACT_HOME`). Find the checkout (first match wins):

```bash
for d in "${WALKTHROUGH_HOME:-}" ~/Projects/operator-skills/skills/walkthrough \
         ~/operator-skills/skills/walkthrough ~/.claude/skills/operator/walkthrough \
         ~/.codex/skills/walkthrough ~/.cursor/skills/walkthrough; do
  [ -n "$d" ] && [ -f "$d/scripts/lint.mjs" ] && { WT_HOME="$d"; break; }
done; echo "${WT_HOME:-NOT FOUND}"
MOTION="${MOTION_ARTIFACT_HOME:-$(dirname "$WT_HOME")/motion-artifact}"   # the sibling skill; used for purity.mjs and render.mjs
```

If it is `NOT FOUND`, stop and tell the user to clone the repo or set `WALKTHROUGH_HOME`. A walkthrough lives in the **app's** repo at `docs/walkthroughs/<slug>/`:

```
walkthrough.src.html   what you author (a copy of template/player.html with the canvas and owners filled in)
walkthrough.html       built by wrap.mjs, runtimes inlined: this is what gets published
manifest.json          cast, labels, mirrored files, engine pins, builtAtCommit (see Step 5)
storyboard.md          the approved storyboard
.wt/                   test pages, screenshots (git-ignore it)
```

All scripts are `node "$WT_HOME/scripts/<name>.mjs" <walkthrough dir>` and need only Node 22+. A browser check drives **headless `agent-browser` with its own `--session`** (never the user's Dia, never Claude-in-Chrome), falling back to a throwaway headless Chrome. Fixtures, tests and the working example: `$WT_HOME/fixtures/minimal/`, `$WT_HOME/tests/`.

## Steps

1. **Resolve** — Settle the app repo (`--from`, else the current repo), the slug (kebab-case, from the app/flow) and the directory. If `docs/walkthroughs/<slug>/` exists, you are in `refresh` mode: jump to the **Refresh** note. `status`: for each `docs/walkthroughs/*/` run `stale.mjs <dir>` and print one line each; stop.
2. **Brief and mode** — Pin the persona and the job ("a foreman staffs next week's crews"). Ask ONE question only if that is unclear. Code available means **fidelity mode** (mirror the real UI). No code means **`--shots`**: capture the running app headless with `agent-browser`, then build from `template/annotated.html` (read it first: hotspots, redact boxes, size caps) and set `"mode": "shots"` in the manifest.
3. **Mirror inventory (fidelity mode)** — Read the real components and routes the flow touches. Write down: a **labels table** (button text, tabs, chips, empty states, each with `file:line`), the app's **tokens** (colors, radii, fonts) and the **cast sources** (`samples/`, seeds, fixtures: where real-looking data lives, so you can avoid it). The walkthrough copies labels verbatim; invented UI text is how a walkthrough lies.
4. **Storyboard, then STOP 1** — Write `storyboard.md`: persona, the job, **5-8 scenes** with **3-5 beats** each (the closing scene may have 1), the **closing principle** in one line, the mirrored files per scene, the **fictional cast** (invented names only), what is hidden on narrow, and the computed runtime (**60-90 s**). Show it and **wait for the user to approve or edit. No code before this.**
5. **Build** — `cp "$WT_HOME/template/player.html" <dir>/walkthrough.src.html`, then fill only the marked regions (the file's header comment lists them), reading `$WT_HOME/template/recipes/README.md` and the recipe closest to each pattern. Write `manifest.json`:

   ```json
   { "slug": "lendhand", "app": "Lendhand", "engine": { "motion": "2.0.0", "player": "1.0.0" },
     "cast": ["Maya Okafor"], "realNames": [], "allow": [],
     "labels": [{ "text": "Check in", "file": "src/Loans.tsx", "scene": "return" }],
     "mirrors": { "return": ["src/Loans.tsx"] }, "datasafety": { "acknowledged": [] } }
   ```

   `repo` (relative path) is only needed when the app source is not the git repo the walkthrough lives in. Then `wrap.mjs <dir>` and `lint.mjs <dir>`; fix until lint is clean. The authoring contract:

   - `#wt-spec` holds `WT.define({brand, badge, foot, canvas, park, scenes:[{id, name, title, lede, len, beats:[[ms,"caption"]], moves:[[at,dur,"#sel",fx,fy,{follow}]], clicks:[[at,"#sel"]], marks:{name:ms}}], closing:"<scene id>"})`: **data only**, no DOM. **All times are scene-relative milliseconds.** Total `len` is the runtime. The cursor moves are layout-derived (`fx,fy` default .5,.55 of the target box), so a CSS change moves the cursor with it.
   - `#wt-owners` holds `WT.own("name", function (t, k) {...})`, then `WT.start()` last. `k.at("scene","mark")` is an absolute time, `k.local(t,"scene")` ms into a scene, `k.mode()` is `"wide"`/`"narrow"`. Helpers (`WT.h`): `rp win pick op css txt cls tr rev num spin`.
   - **One owner per element property.** An element's opacity, text, class or transform is written by exactly one owner; combine the logic, never stack writers. **Build all DOM up front** and toggle it; a cue that creates nodes cannot be scrubbed. **No CSS `transition`/`animation`, no timers, clocks or randomness**; `lint.mjs` and `/motion-artifact`'s `purity.mjs` fail them.
   - Narrow (phone) is a second layout of the same canvas (`.is-narrow` hooks, size `canvas.narrow`). **Every move/click target must be laid out in both layouts**; if a thing is hidden on phone, do not point the cursor at it.
   - Chrome classes are `wt-*`, chrome tokens `--wt-*`; yours are the app's own and use `--app-*`. Write dark values once under `:root[data-theme="dark"]` (`?theme=light|dark` overrides the OS). Google Fonts are fine; keep system fallbacks in the stack. Nothing else external.
   - Artifact page contract (already in the template): no doctype/`<html>`/`<head>`/`<body>`, the page starts at `<title>`, `<meta name="claude:viewport-fit-sides" content="cover">`, safe-area padding, full light and dark tokens, readable at 390 px.
6. **Data safety, then STOP 2** — `datasafety.mjs <dir>` (add `--history` for git history). It gates the cast, the repo's data and docs, known real names, emails, phones, street addresses, and given names that are not in the cast. **Show the user every flagged name and collision. Nothing publishes until each one is fixed or the human acknowledges it** (the script prints the exact `kind:text` key to add under `datasafety.acknowledged`). Real client staff names never go in a walkthrough: use invented names or role titles. Read the page's visible text yourself as well: the script is a net, not proof.
7. **QA loop (cap: 3 rounds, then report what is left)** — Run all of:

   ```bash
   node "$WT_HOME/scripts/lint.mjs"  <dir>
   node "$WT_HOME/scripts/audit.mjs" <dir>      # moves/clicks land, no double writers, nothing past the canvas, no h-scroll, theme, reduced motion, both layouts
   node "$MOTION/scenes/purity.mjs" <dir>/.wt/test.html          # MOTION = the motion-artifact skill folder
   node "$MOTION/scenes/purity.mjs" <dir>/.wt/test.narrow.html   # the phone layout
   node "$WT_HOME/scripts/shoot.mjs" <dir>                       # light, dark, phone, tablet PNGs + contact sheets in .wt/shots
   ```

   **You must read the frames yourself** (open each contact sheet and the full-size PNGs for any doubt) and list defects: clipped or overlapping text, a cursor that is not on its target, a state that never settles, ugly empty space, wrong caption for the frame. Do not delegate that judgment and do not assume green scripts mean good frames. Fix the source, `wrap.mjs`, repeat. `shoot.mjs --scenes a,b` re-shoots only some scenes; `--beats` shoots every beat.
8. **Private publish** — Load the artifact-design skill if the environment has one, and follow the page contract. Publish `<dir>/walkthrough.html` with the Artifact tool and report the URL. Republishing to the same URL needs that URL passed back. Artifacts are private by default; publishing is not sharing. If the environment has no artifact publisher, hand over the file path and stop. Size: `lint.mjs` warns at 150 KB and fails at 500 KB; check the Artifact tool's documented size limit before relying on those numbers.
9. **Optional public link, then STOP 3** — Only if asked. First restate to the user: the **cast** (every name shown), the **Cloudflare account**, the **Worker name** (`wt-<slug>`) and that the public URL will be `https://<name>.<subdomain>.workers.dev`. Wait for an explicit yes. Then:

   ```bash
   node "$WT_HOME/scripts/deploy.mjs" <dir>          # dry run: builds the site, runs the guard, uploads nothing
   node "$WT_HOME/scripts/deploy.mjs" <dir> --yes    # only after the yes
   ```

   It refuses while `datasafety` has findings. **It refuses to overwrite an existing Worker that does not carry the tag `walkthrough:<slug>`, and refuses when it cannot tell** (auth or network errors are not "free"). Deploys are tagged `walkthrough:<slug>`; the page ships `noindex,nofollow`, `robots.txt` and `_headers`, and the script then fetches `/robots.txt` and the headers of `/` and reports them. The account comes from `--account`, `deploy.json` (`{"name","accountId"}`), or `CLOUDFLARE_ACCOUNT_ID`; with several accounts it stops and asks. A `--shots` walkthrough needs a second explicit confirmation and `--confirm-screenshots`.
10. **Optional export** — `node "$MOTION/scenes/render.mjs" <dir>/.wt/test.html --format mp4` (wide) and `.wt/test.narrow.html` (phone); `--format gif`, `--from/--to` for a range. Needs ffmpeg for mp4/gif. Report the size.
11. **Stamp** — `stamp.mjs <dir>` writes the app's HEAD sha, today's date and the engine versions into `manifest.json` (it refuses if the mirrored files have uncommitted edits). **Never commit, push or publish for the user.** Say which files changed and let them commit.

### Refresh

`stale.mjs <dir> --json` lists the scenes whose mirrored files, labels or the engine moved since `builtAtCommit`. Redo Step 3 for those scenes only, edit only those scenes (and the narration around them), then Steps 5-7 (`shoot.mjs --scenes <ids>`), then 11. If the **engine** drifted, every scene is suspect: run the full QA. If nothing is stale, say so and stop. `stale.mjs` never moves the baseline; only `stamp.mjs` after a passing QA does.

## Notes

- **Why a path dependency on `/motion-artifact`.** `wrap.mjs` inlines its `scenes/motion.js` verbatim, the player runs every owner inside one `S.cue(0, END)` and sets `window.__motion` itself, and `purity.mjs`/`render.mjs` run unchanged. The engine version is pinned in the manifest; `lint.mjs` and `stale.mjs` fail on drift. No fork. Keep walkthrough fixtures outside `motion-artifact/scenes/` (its `check.mjs` assumes a bare canvas).
- **Limits are enforced, not advisory:** 5-8 scenes, 3-5 beats (closing exempt), 60-90 s, captions under about 4 words per second, first beat at 0, moves/clicks/marks inside their scene.
- **Reduced motion** steps caption by caption on each beat's resting frame (`?reduced=1` forces it for QA). **Export mode** (`window.__motionExport`) hides the shell and renders the bare canvas at native size.
- **Real names.** The reference case: a published walkthrough that named two real client staff. `datasafety.mjs` exists to catch exactly that; replace such names with role titles or invented ones and re-shoot.
- **The public page is public.** Anyone with the link can view it and its source. Do not put anything in it you would not put on a billboard.
- Use `/motion-artifact` for a short silent loop of one feature, `/collateral-set` for a family of static client pages, `/verify-app` for checking a running app, and `/report` for a data dashboard. This skill is for a guided, narrated, replayable tour of a flow.
