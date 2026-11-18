---
name: premium-video-ad
description: >
  Make a premium motion-design video ad, promo cut or product walkthrough for a product or brand, in 16:9 and 9:16, from bundled code-rendered engines (six beat, timeline, continuous flow) with a beat-locked synthesized soundtrack. Use for a video ad, promo, Reels or Instagram ad, explainer or walkthrough video, or a new skin of an earlier cut. Not for editing user-supplied footage.
argument-hint: "<product or brand> [--vertical] [--template six-beat|timeline|flow]"
---

# Premium video ad

Agency-grade motion design ads rendered from code: one config file per ad, scenes drawn in HTML, frames captured with Playwright, encoded with ffmpeg, and an original soundtrack composed on the same beat grid as the cuts. No live footage, no voice-over.

Task: $ARGUMENTS

This skill ships working engines in `engines/`. **Copy an engine, don't rebuild one.** Rebuilding from a written contract costs most of a session and drifts in quality; a copied engine renders its first frames within minutes.

| Engine | Folder | Runtime | Formats | Best for |
|---|---|---|---|---|
| Six beat | `engines/six-beat/` | ~25 s, hard cuts | 16:9 and 9:16 (`:v`) | Feed ads, openers, a clear before and after |
| Continuous flow | `engines/continuous-flow/` | ~40 s, one camera, no cuts | 16:9 | Walkthroughs, "how it works", landing page heroes |
| Timeline | `engines/timeline/` | ~25 s, six beat grid | 16:9 and 9:16 (`:v`) | Products that make or process media, or any brand that wants the ad to act out the work: clips snap to the beat on an editor timeline |

Pick by what the product does. The six beat engine is the safe default. The timeline engine is the premium choice when the product's work can be shown as assembly (edits, documents, builds, orders coming together). Continuous flow is for explaining a process step by step. To make something visibly new, see "Adding a template".

## What the user gets

1. A shot list (beat, time, copy, motion, sound cue) and three alternative hooks.
2. Three style frames before the full render.
3. MP4s (1920x1080 and, for social, 1080x1920; 30 fps, H.264, AAC 256k, about -14 LUFS) and the WAV.
4. A zip of the engine folder with the ad's config and a README.
5. An honest handoff: what is real, what is placeholder, what was not checked.

## Step 0: Set up a work folder

```bash
W=<scratchpad>/ad-<name>; mkdir -p "$W"; cp -R <this skill>/engines/<engine>/. "$W"/
cd "$W" && npm init -y >/dev/null && npm i playwright-core @fontsource-variable/fraunces @fontsource-variable/inter
python3 -m venv .venv && .venv/bin/pip -q install numpy scipy
```

- The engines render with system Chrome at `/Applications/Google Chrome.app/...` through playwright-core. Change `CHROME` in `render.mjs` on other machines.
- Fonts load from `node_modules/@fontsource-variable/*` through `@font-face` at the top of the page. For another brand, install its fonts from npm and edit those lines. If the brand uses system fonts, pick close open stand-ins and say so.
- `render.mjs` serves the folder over a local HTTP server. Fonts fail to load from `file://`, so never open the page directly for frames.
- Run long renders in the background. A 25-second cut renders in under a minute on a recent Mac.

## Step 1: Research before writing a word

- **Brand from code when you have the repo.** Read the CSS tokens (`styles.css`, Tailwind theme, `:root`), the font imports, and the logo or favicon SVG. Chrome supports `oklch()`, so tokens can be pasted as is. Without a repo, open the live site in the browser tool and read computed styles from `:root`, headings, and buttons.
- **Copy from the product's own pages.** Take the hook from the problem statement, the claim from the hero, and the proofs from the listed features. Use only claims the site makes. Remove em dashes when quoting.
- **Real numbers from source.** Package prices, credit costs and status labels should come from the code (pricing modules, status label maps), not be invented. Anything you do invent must be clearly fake (Northwind Studio, 142 Alder Lane, Dana).
- **Honesty about behavior.** Don't animate a feature that doesn't exist. For example, don't show a typed brief being parsed into fields unless the product actually does that. When in doubt, show the real form being filled in.
- Check where the ad sends people (the URL on the end card). If that page pitches something else, or an offer code on the card doesn't exist yet, flag it.
- Regulated or sensitive brands: keep screens generic and say the cut needs client approval.

## Step 2: Write the beats

Six beat:

| Beat | Default time | Job |
|---|---|---|
| Hook | 0–3 | Three short lines on beats 0/1/2. The last line is highlighted |
| Tension | 3–7 | Eight chips (files, links, messages) land faster and faster, then one blunt question at 5 |
| Reveal (sort) | 7–10 | Drop at 7. Chips snap upright, slide into a window and become product rows. Three-line claim on 8/8.5/9 |
| Proof x3 | 10 / 13 / 16 | Two-line title, one sub line, one card whose events land at +0.5, +1.0, +1.5 and +2.0 s |
| Payoff | 19–22 | The outcome in the buyer's words, two lines, the second highlighted |
| End | 22–25 | Mark, wordmark, offer pill, URL |

Card types in the six beat engine are `form` (selections and a typed link fill in, then confirm), `counter` (balance ticks up and down with ledger rows) and `track` (a five-step status rail ending in a primary button). Add a card type behind `proof[n].type` rather than editing an existing one, so older configs keep rendering.

The timeline engine uses the same grid and the same three card types, staged inside a video editor. The canvas has a bin, a preview monitor, an order panel and V2, V1 and A1 tracks.
- **Hook and payoff:** editorial type pages with a folio, crop marks and a marker stroke over `mark.text`.
- **Tension:** raw items pile into the bin faster and faster, and the monitor asks the question.
- **Drop:** films (`tension.items` entries with a `kind`) fly from the bin and snap onto V1 one per beat, the music item lands on A1, and the playhead starts sweeping. Claim lines are V2 title clips burned into the monitor.
- **Proofs:** they play out in the order panel while title clips advance on V2.
- **Payoff and end:** every track collapses into one exported clip, and the end card plays on the monitor with format chips and a delivery button.
- Footage is abstract gradient art (aerial, day, interior, dusk, twilight, gold), never photos. Long clip names truncate with "…" the way editing apps do.

The continuous flow engine has five stations on one canvas, each holding 4.5 s and then travelling 1.5 s. It pulls back at 30–33 with a headline at 32, and the end card runs 36–40. It has two named cursors, a corner map and a numbered caption per station. Stations and cursor keyframes live in its config (`layout: "flow"`).

Copy rules: sentence case, no exclamation marks, no em dashes, no filler. Read every line aloud. Break titles by hand, and never leave a one-word orphan line. That includes vertical restacks: "More listings / shot." is an orphan, so keep two lines at a smaller size instead.

## Step 3: Beat grid

The default tempo is 120 BPM (0.5 s per beat). Every cut and every in-scene event lands on a beat or half beat. Leave a quarter second of silence before the drop.

## Step 4: Style frames first

```bash
node render.mjs frames <config> frames 2.9 6.5 7.75 9.9 12.6 15.6 18.6 21.5 24.5     # six beat
node render.mjs frames <config>:v frames-v 2.9 9.9 12.6 21.5 24.5                      # same, 9:16
```

Look at every frame at full size, and also at one in-between frame per transition. Typical problems:

- Moving elements crossing text. In the sort reveal, the chips fly across the claim area, so the claim must start after they clear (1.0 s into the reveal, not 0.5).
- Clipping at the right edge of tilted cards, and cards with dead space at the bottom.
- Orphans, and highlight bars that don't span the whole line.
- Light skins: use soft shadows instead of glows, and check that dimmed items still read.
- Continuous flow: check a frame mid-move as well as each landing, and keep cursor labels off text.

Send three frames (hook, reveal, one proof). If the user asked to approve frames, wait. Otherwise keep going.

## Step 5: Render, then verify like a viewer

```bash
node render.mjs video <config> out/<name>-silent.mp4            # all scenes, then concatenated
node render.mjs video <config> out/<name>-silent.mp4 reveal     # re-render one scene, then re-concat
node render.mjs video <config>:v out/<name>-v-silent.mp4        # 9:16
```

Then probe the file (frame count, duration, size) and build a contact sheet of a dozen in-between frames:

```bash
ffmpeg -i out.mp4 -vf "select='eq(n\,20)+eq(n\,100)+…',scale=480:-1,tile=4x4" -fps_mode passthrough -frames:v 1 contact.jpg
```

Use `-fps_mode passthrough`; ffmpeg 7 and later rejected `-vsync`. The contact sheet is where stuck states and overlaps show up, so look at it yourself even when a subagent built the cut.

## Step 6: Vertical 9:16

The six beat engine has a real vertical layout, not a crop. Append `:v` to the config name. Copy goes on top and the card goes below, with card entrances rising from below instead of swinging in from the right. Payoff and end card restack, chip poses are remapped, and the background glows move.

- **Reels safe zone:** keep anything important between y 250 and y 1500. The top holds the account bar; the bottom 400 px and the right 140 px hold the caption and buttons.
- Optional `payoff.linesV` and `payoff.hlV` restack the payoff for vertical. Check them for orphans.
- The timeline engine's vertical layout stacks the monitor on top, then the bin and order panel, then a compressed timeline. Expect empty background below y 1500; that is the safe zone working.
- The continuous flow engine is 16:9 only. For a vertical walkthrough, render the stations as a stack instead of reframing the canvas.

## Step 7: Soundtrack

Each engine has a `soundtrack.py` that synthesizes an original scratch track on the cut's grid, with keys, pad, kick, snap, shaker, bass, arpeggio, ticks, blips, chimes, whooshes, a riser and an impact. It sidechains pad and bass to the kick, adds a short reverb send, gates silence before the drop, soft-clips, and loops loudness to -14 LUFS through ffmpeg `ebur128`. It prints RMS per section: keep the hook at least 6 dB under the groove and confirm the gap is silent. Loudness must be measured on the stereo file you ship. Measuring a mono mix and then duplicating it to two channels comes out 3 dB hot (about -11 LUFS), so confirm the final MP4 with `ffmpeg -i final.mp4 -af ebur128 -f null -`.

When you change a scene's event times, move its cues in `soundtrack.py` to match. Join with:

```bash
ffmpeg -i silent.mp4 -i track.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest final.mp4
```

The same WAV serves both 16:9 and 9:16 because the timing is identical. You cannot hear the result: say it was checked by levels, waveform and timing only, and ask the user to listen. To swap in a licensed track, choose one at the same BPM (±2) and put its drop on the reveal time. A music library connector, if one exists, can be searched by tempo; don't download without being asked.

## Step 8: Delegating

Two cuts (for example a promo and a walkthrough) can be built in parallel. Give each subagent its own work folder copied from the engine, the brand tokens, the real numbers, a placeholder-name rule, and the instruction not to send files or write memory. Ask for a short report. Then check its contact sheet and three full-size frames yourself before delivering.

## Step 9: Deliver and be straight about it

Send the MP4s, the WAV and the template zip. List:
- what is real (brand tokens, copy sources, prices) and what is placeholder (names, addresses, balances);
- whether the behavior shown exists and matches a real screen;
- whether the offer and landing page match, for example a promo code that still has to be created;
- what was not verified, including the audio by ear and playback at full speed.

## Adding a template

When the user wants something visibly new, first mock three directions as two still frames each, in the brand skin, and let them pick. Build the pick as `engines/<name>/` with the same interface: a `?c=` config, a pure `window.seek(t)`, `window.SCENES`, `window.ready`, and a `render.mjs` with `frames` and `video` modes and per-scene re-renders. Then add a row to the engine table above.

## Notes

- `/motion-artifact` animates a single feature as a clip or GIF for a release note. Use this skill when the ask is a full ad with an arc and a soundtrack.
- `/walkthrough` builds an interactive, auto-playing page of a real app. Use the continuous flow engine here when the deliverable is a video file.
- `/collateral-set` pairs well: the ad's end card can point at a landing page from that set.
- The engines need Node, Python with numpy and scipy, ffmpeg and Google Chrome. Nothing here publishes or sends anything; delivery is the user's call.

