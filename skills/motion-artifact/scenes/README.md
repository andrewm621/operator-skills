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
| `phone-wide-release.html` | phone-wide 900×560 | a device beside a caption; the release-note shape | `--scale 720` |
| `checklist-complete.html` | square 800×800 | `sequence()` ticking pre-built rows; square crops for LinkedIn/IG | `--scale 640` |
| `feature-story.html` | story 540×960 | 9:16, one idea, type sized to be read in two seconds | `--scale 540` |

Each file opens with a `PRESET / SHOWS / FORK` comment saying what to change.

**Render at the width in that last column.** Upscaling a small canvas is the fastest way
to a huge GIF for no benefit — `feature-story` at `--scale 700` is 1.2 MB and at its
native 540 it is 734 KB, with no visible difference. Downscaling too far is the opposite
failure: `onboarding-flow` at `--scale 700` loses the step-rail rings entirely, because a
2px border on a dark ground does not survive GIF quantisation. If a scene must go out
small, thicken its hairlines first.

## Checks

```bash
node check.mjs           # static rules — fast, no browser
node check.mjs --purity  # + prove each scene is a pure function of t (Chrome)
node check.mjs --render  # + render each scene end to end (Chrome + ffmpeg)
node check.mjs --all     # everything
node check.mjs foo.html  # one scene
```

Every static rule exists because the bug shipped at least once — that's the bar
for adding one, not "seemed like good practice". They enforce the skill's own
hard rules: no CSS `transition`/`animation`, an exact `html,body` canvas that
*matches* `Motion.scene({width,height})`, no external refs, `scroll()` with an
explicit `from`, `type()` never targeting an element with child markup, and one
cue owning each property per element.

`purity.mjs` is the interesting one. It loads the scene in Chrome and compares
the **DOM** after a cold seek to `t` against the DOM after playing forward to
`t`, at samples across the timeline — then prints exactly what differs:

```
✗ coldseek.html — IMPURE at t=3200, 3467, 3733ms
    warm (played forward): <div id="s" class="done">Connecting...</div>
    cold (seeked direct):  <div id="s" class="done">Connect</div>
```

It compares DOM rather than pixels on purpose. The renderer computes `t` as
`from + f*1000/fps`, which in IEEE754 is not bit-identical to
`(f+shift)*1000/fps` — so diffing frames across two `--from` offsets can report
a subpixel difference that is float drift, not a real purity break. DOM
comparison has no such failure mode, needs no ffmpeg, and says what broke.

CI runs the static rules and the purity check on every PR
(`.github/workflows/checks.yml`); `--render` stays local because it needs ffmpeg.

## Files

- `motion.js`, `render.mjs` — **generated** from `../SKILL.md`. Don't edit them here.
- `sync.mjs` — regenerates the two files above.
- `check.mjs`, `purity.mjs` — the checks above.

```bash
node sync.mjs            # after editing SKILL.md
node sync.mjs --check    # exits 1 if they have drifted
```

`SKILL.md` stays the source of truth because claude.ai web users only ever get the
Markdown. These are extracted copies so a scene can `<script src="motion.js">` instead of
carrying 400 inlined lines. A scene you ship somewhere else should inline the runtime —
that's what makes it self-contained.

## Requirements

Needs Node 22+ (built-in `WebSocket`), a Chrome/Chromium binary, and `ffmpeg` on PATH.
The renderer finds Chromium in the Playwright and Puppeteer caches as well as the usual
system paths. Note that **Playwright's bundled ffmpeg will not work** — it is compiled
`--disable-everything` and has no gif or x264 encoder. Use a system ffmpeg or
`npx ffmpeg-static`.
