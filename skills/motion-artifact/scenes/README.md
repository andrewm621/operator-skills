# Scenes

Seven working motion scenes for `/motion-artifact`. **Fork the closest one instead of
writing cues from a blank page** — every scene here has been rendered and looked at, so
you start from something that already works and only change content.

```bash
cp scenes/dashboard-fill.html my-clip.html   # take motion.js along too
node render.mjs my-clip.html --format gif --scale 900
```

## The catalog

| Scene | Canvas | Demonstrates | Render at |
|---|---|---|---|
| `onboarding-flow.html` | desktop 1200×675 | `cursor()` → `click()` → `type()` → `states()`; the "someone is using the product" loop | `--scale 900` |
| `search-results.html` | desktop 1200×675 | typed query, a busy state, `reveal()` with `stagger`, `counter()` | `--scale 900` |
| `pipeline-run.html` | desktop 1200×675 | one `states()` machine per stage, `progress()`, `sequence()` streaming log lines | `--scale 900` |
| `dashboard-fill.html` | desktop 1200×675 | `counter()`, `progress()`, `tween({height})` bars growing from a baseline | `--scale 900` |
| `phone-concierge.html` | phone 420×660 | the mobile device frame — phone fills the canvas instead of being letterboxed | `--scale 420` |
| `checklist-complete.html` | square 800×800 | `sequence()` ticking pre-built rows; square crops for LinkedIn/IG | `--scale 640` |
| `feature-story.html` | story 540×960 | 9:16, one idea, type sized to be read in two seconds | `--scale 540` |

Each file opens with a `PRESET / SHOWS / FORK` comment saying what to change.

**Render at the width in that last column.** Upscaling a small canvas is the fastest way
to a huge GIF for no benefit — `feature-story` at `--scale 700` is 1.2 MB and at its
native 540 it is 734 KB, with no visible difference. Downscaling too far is the opposite
failure: `onboarding-flow` at `--scale 700` loses the step-rail rings entirely, because a
2px border on a dark ground does not survive GIF quantisation. If a scene must go out
small, thicken its hairlines first.

## Files

- `motion.js`, `render.mjs` — **generated** from `../SKILL.md`. Don't edit them here.
- `sync.mjs` — regenerates the two files above.

```bash
node sync.mjs            # after editing SKILL.md
node sync.mjs --check    # exits 1 if they have drifted
```

`SKILL.md` stays the source of truth because claude.ai web users only ever get the
Markdown. These are extracted copies so a scene can `<script src="motion.js">` instead of
carrying 400 inlined lines. A scene you ship somewhere else should inline the runtime —
that's what makes it self-contained.

## Local checks

```bash
# every scene still renders
for f in *.html; do node render.mjs "$f" --format frames --dpr 1 --out /tmp/chk || echo "FAILED $f"; done

# cold-seek purity: a sub-range must match the full render at the same t
node render.mjs pipeline-run.html --format frames --out fa
node render.mjs pipeline-run.html --format frames --from 3000 --out fb
cmp fa/f_00092.png fb/f_00002.png && echo "COLD SEEK OK"   # 30fps: 3000ms = 90 frames
```

Needs Node 22+ (built-in `WebSocket`), a Chrome/Chromium binary, and `ffmpeg` on PATH.
The renderer finds Chromium in the Playwright and Puppeteer caches as well as the usual
system paths. Note that **Playwright's bundled ffmpeg will not work** — it is compiled
`--disable-everything` and has no gif or x264 encoder. Use a system ffmpeg or
`npx ffmpeg-static`.
