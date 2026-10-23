# walkthrough

Guided, auto-playing app walkthroughs as one self-contained HTML page. The prompt is `SKILL.md`; this
file is for people changing the skill.

```
SKILL.md        the skill (mirrored verbatim into docs/claude-ai-skill-reference.md)
template/       player.html (shell + canvas contract), player.js (the WT runtime), recipes/, annotated.html
scripts/        wrap lint audit shoot datasafety stale stamp deploy   (+ _lib, _browser)
fixtures/minimal/   a five-scene fictional walkthrough; CI runs every check against it
tests/          node --test tests/*.test.mjs   (no browser needed; deploy tests use a stub wrangler)
```

## The runtime boundary

The player does not fork `/motion-artifact`. `wrap.mjs` inlines `../motion-artifact/scenes/motion.js` verbatim,
WT runs all owners inside one `Motion.scene().cue(0, END, ...)`, never calls `mount()`, and sets `window.__motion`
itself, so motion-artifact's `purity.mjs` and `render.mjs` run on a walkthrough unchanged. The runtime versions are
pinned in each walkthrough's `manifest.json` (`engine.motion`, `engine.player`); bumping `Motion.version` or
`VERSION` in `player.js` fails `lint.mjs` and CI until the fixture is re-QA'd and restamped.

Keep walkthrough fixtures out of `skills/motion-artifact/scenes/`: its `check.mjs` assumes a bare canvas.

## Checks

```bash
node --test skills/walkthrough/tests/*.test.mjs
F=skills/walkthrough/fixtures/minimal
node skills/walkthrough/scripts/lint.mjs $F
node skills/walkthrough/scripts/audit.mjs $F --driver chrome
node skills/motion-artifact/scenes/purity.mjs $F/.wt/test.html
node skills/motion-artifact/scenes/purity.mjs $F/.wt/test.narrow.html
node skills/walkthrough/scripts/datasafety.mjs $F
```

If you change `player.js`: re-run all of the above, bump `VERSION` when existing walkthroughs' frames would change,
and restamp the fixture's `manifest.json` `engine.player`.

## Deploy guard

`deploy.mjs` tags every Worker `walkthrough:<slug>:<repo id>` and refuses to touch one without that exact tag. The id is public, so a redeploy also needs the per-user record (id and repo path) in `~/.config/walkthrough/owned.json` or `--adopt`; tests point `HOME` at a temp dir. The ownership check
reads `wrangler versions list` and `deployments list` (`workers/tag`, or the tag token in `workers/message`); a
not-found answer is recognised by Cloudflare's `[code: 10007]` text, anything else (auth, network) refuses. Test it with
`tests/stub-wrangler.mjs`; do not deploy test Workers to a real account from CI.
