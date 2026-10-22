# Owner recipes

Copy-paste starting points for `WT.own(...)`, distilled from real walkthroughs. They are NOT bundled
into the runtime: copy the one you need into the `wt-owners` script and rename the ids.

Every recipe follows the same contract:

- **One owner per property.** An element's opacity, text or class is written by exactly one owner.
  `audit.mjs` fails a walkthrough where two owners write the same thing.
- **Every frame is a function of `t`.** Compute state from `t` and the scene marks (`k.at("scene", "mark")`,
  `k.local(t, "scene")`); never remember what happened last frame.
- **Build DOM up front.** Hide it with the helpers (`op`, `cls`) instead of creating nodes during playback.
- Times are scene-relative in the spec; `k.at` turns them into absolute milliseconds for the owner.

| Recipe | Pattern | Used by the fixture |
|---|---|---|
| `screens-and-tabs.js` | a screen visible between two marks, tab follows | yes |
| `typed-filter.js` | typed query, matching cards stay, others dim | yes |
| `button-states.js` | press ring, label swap, spinner, result badge | yes |
| `drawer.js` | scrim plus a side drawer (wide) or bottom sheet (narrow) | yes |
| `checklist-counter.js` | ticks, a status flip, a counter that changes | yes |
| `paste-preview.js` | pasted rows appear, preview counts up, a second paste updates rows | no (from a real walkthrough) |
| `drag-card.js` | a card lifts from a rail, follows the cursor, drops into a lane | no (from a real walkthrough) |
