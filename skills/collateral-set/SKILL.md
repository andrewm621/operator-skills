---
name: collateral-set
description: >
  Produce a cohesive set of client-facing HTML artifacts (explainers, pitch, landing page, calculator, case study, playbook) in one sitting on the vendored kit and one Theme Core theme — build one anchor by hand, fan the rest out to parallel subagents (view specs where a page fits the blocks), gate every page with the kit lint and for accuracy, and publish them centrally as live Artifacts.
argument-hint: "<client> [archetypes, e.g. 'explainers x3 + landing + calculator']"
---

Produce a cohesive set of client-facing HTML artifacts in one sitting: anchor first, parallel fan-out, central gate and publish.

Request: $ARGUMENTS

Use this when a client or product needs *several* polished pages that must read as one family — a handful of motion explainers for a sales conversation, plus go-to-market pieces (landing page, ROI calculator, waitlist, case study, playbook). One page is a normal artifact request; this skill is for five to ten of them without the set drifting into five to ten different looks.

## The one idea that makes this work

**Cohesion comes from files, not from a description.** Parallel agents given a *written* style brief each reinvent it slightly — a different grey, a different heading size, a different card radius — and the set falls apart. So nobody writes a palette. Every page links the same three things: the **vendored kit** (`kit/kit.css` + `kit/blocks.css`, the Theme Core contract: bare HTML and 12 blocks that already look finished), **one theme** (`kit/themes/<slug>.vars.css`, or a client's gated `<slug>.vars.css`), and **`board.css`** (the explainer board, the one component kit has no block for). A page can't drift a colour it never wrote, and `node kit/render.mjs check` fails one that tries. You still build one anchor by hand and get the look approved before fanning out, because the anchor is where the theme, the mode and the content patterns get decided.

Only two inputs change per client: **the theme** and **a fact sheet**. The kit, the anchor structure, the brief template, the guardrails, and the gate are client-agnostic.

## Where things live

`kit/` (the vendored kit: `render.mjs`, `kit.css`, `blocks.css`, themes `house`, `paper`, `obsidian`, `midnight-cyan`, `slate-amber`, and `kit.lock.json`) and `templates/` (`anchor.html`, `board.css`, `fact-sheet.md`) sit next to this skill; in the operator-skills repo at `skills/collateral-set/`. Call that folder `$CS_HOME`. The scripts need Node 22+ and nothing else.

A set lives in one folder in the client's repo (e.g. `collateral/<family>/`):

```text
kit/                     cp -R "$CS_HOME/kit" .   (the pinned copy: never edit it)
board.css                cp "$CS_HOME/templates/board.css" .
theme/<client>.vars.css  only for a client theme (step 1)
fact-sheet.md            the only source of claims
<page>.html              hand-built pages (static documents on kit)
<page>.view.json         view specs, rendered by kit/render.mjs
out/<page>.artifact.html what gets published (step 7)
```

## Steps

1. **Intake** — Settle these before building anything. Ask for what's missing; don't invent it.

   | Input | Where it comes from | Default if absent |
   |---|---|---|
   | Theme | a built-in Theme Core theme, or a client theme (below) | `house`; say which built-in you picked and why |
   | Fact sheet | `templates/fact-sheet.md`, filled from real sources (calls, docs, repo) | **no default** — without it, every number is "illustrative" |
   | Archetypes and count | the request; see the [archetype menu](#archetype-menu) | 3 explainers + 1 landing |
   | Mode per page | audience and where it's shown | `auto` (the viewer's light/dark); `dark` for screen-share explainers, `light` for landing pages, if the user wants one look |
   | Audience and use | who sees it, where (call screen-share, email, site) | sales conversation, shared by link |

   Write the fact sheet to disk (e.g. `collateral/<family>/fact-sheet.md` in the client repo) — every subagent will read it. Mark each number *real* (with source) or *illustrative*.

   **Theme.** One theme for the whole set, never colours. Built-ins vendored here: `house` (warm paper, terracotta; the default), `paper` (editorial: Fraunces and Plex Mono, persimmon), `obsidian` (neutral grey, for a brand you can't match yet), `midnight-cyan` (dark-first, screen-share), `slate-amber` (navy-grey with an amber signal). **A client brand** becomes a Theme Core theme that has to pass the contrast gate:
   - Write `theme/<client>.theme.json` (contract 1: `primary`, `neutral`, `fonts`, `radius`, `surface`, `sidebar`, `motion`; field reference in the design-system repo at `src/theme-core/types.ts`, examples in its `themes/`).
   - Build and gate it from the design-system checkout on this machine (`$PROJECTS/design-system`, where `$PROJECTS` is `paths.projects` from `~/.config/operator-skills/config.yaml`, default `~/Projects`), with absolute paths: `pnpm --dir "$PROJECTS/design-system" theme:resolve "$PWD/theme/<client>.theme.json"`. It writes `theme/<client>.vars.css` only when every pair passes AA, and lists the failing pairs otherwise. The six-line minimum usually fails on the derived status colours and dark muted text: set `status` (success and info, light and dark) and a dark `muted-foreground` override, and rerun.
   - Pages link `theme/<client>.vars.css` where the anchor links `kit/themes/house.vars.css`; views set `"theme": "theme/<client>.vars.css"`. A client theme brings no fonts: link its families on each hand page.
   - **No design-system checkout, or the gate won't pass in a few tries:** use the nearest built-in theme, say so, and list the brand colours you didn't use in the hand-off. Never hand-write a token block to get the colour in.

2. **Build the anchor by hand** — Set up the folder (above): copy `$CS_HOME/kit` and `$CS_HOME/templates/board.css` in, then copy `$CS_HOME/templates/anchor.html`. Change its theme link, its fonts link (`fontsHref` for the theme in `kit/themes.json`) and `data-mode` on `<html>`, then fill it with the strongest real content you have — usually the core mechanism explainer. Do this yourself, not via a subagent: the anchor is the design decision, and you need to have looked at it.

   The anchor is a **kit page**, and every sibling inherits its contract:
   - A whole static document: theme vars, `kit/kit.css`, `kit/blocks.css`, then page sheets (`board.css`), and `data-kit data-shell="page"` on `<body>`. Preview it from disk as it is; `pack` turns it into an Artifact at publish time (step 7).
   - `<title>`: 2–4 words, a name ("Consensus Extraction"), not "Name: explainer".
   - **No `style=""` attributes, no colours anywhere in the markup or in page CSS, no `:root` token block.** Colours come from the theme's vars (`--primary`, `--card`, `--muted-foreground`, `--chart-2`, `--tone-success-fg` …), read in page CSS as `var(--x)`. Every `<section>` has an `aria-label`.
   - **Kit blocks where one fits** (`page-header`, `stat-row`, `chips`, `callout`, `page-footer` …; markup as `render.mjs` writes it, see `kit/blocks.json`). Page CSS only for what no block covers, scoped under `[data-kit]`, reading theme vars only, and small: say what it's for in a comment.
   - Light and dark come from `data-mode` on `<html>` (`auto`, `light` or `dark`) and the theme's vars file, which holds both. Never paint a mode by hand, never toggle with `data-theme`.
   - Readable at rest — all content in HTML; motion decorates. JS optional and wrapped in `try`. `prefers-reduced-motion` stops the motion (kit and `board.css` handle it).
   - Holds at 375px with no horizontal scroll. Google Fonts are the only remote file.

   `board.css` covers the motion explainer (stages, rails, agreement rows, resolver, output card). A new mechanism shape that needs more goes in the anchor's own `<style>`, then into the briefs as "copy this `<style>` block verbatim".

3. **Confirm the look** — Publish the anchor alone (step 7 mechanics) and show it to the user, in both modes if it's `auto`. Get an explicit yes on the theme, the mode and the density *before* fanning out. Swapping the theme later is one link per page, but re-checking nine pages of content against a new look is still the whole review again.

4. **Write the briefs** — One per remaining artifact, using the [subagent brief template](#subagent-brief-template). Each brief carries: the anchor path, the set folder, the fact-sheet path, the archetype, **the form** (a view spec or a hand-built page, below), a content spec (sections, what each proves, which real numbers go where), the mode, the guardrails verbatim, and an output path. Name *which* real numbers each page may use — agents under-use a fact sheet they merely have access to.

   **Prefer a view spec.** A page that is headers, numbers, steps, decisions, actions, tables, cards, callouts and a footer (strategy doc, playbook, status, dashboard, case study, most landing pages) is a `<page>.view.json` rendered by `node kit/render.mjs`: no HTML or CSS written at all, the spec is small and diffable, and it re-renders in another theme with one flag. The 12 blocks, their options and their data are in `kit/blocks.json` (schema: `kit/view.schema.json`; links and calls to action go in `page-header`/`callout` `actions`, plan cards in `card-grid`). Hand-build only what needs custom layout or interaction: motion explainers (`board.css`), calculators and interactive tools, a pitch split that animates.

5. **Fan out** — Spawn all briefs in one message, in parallel, in the background. Route to an agent that **can write files** — `coder` or `general-purpose`. The `writer` agent is read-only in most setups: it returns text and you end up landing the files yourself. Past ~5 visible agents or with retry logic, graduate to the Workflow tool per `/orchestrate`.

   Subagents **write files only**. They do not publish, open, or share — the orchestrator publishes, so titles, icons, and descriptions stay consistent and nothing goes out ungated. They run `node kit/render.mjs check` on their own output before returning.

6. **Gate every page** — Before publishing, from the set folder. Mechanical checks first, then look at it:

   ```bash
   node kit/render.mjs verify                         # the kit copy is untouched (matches kit.lock.json)
   node kit/render.mjs check *.view.json *.html       # kit lint + view validation: inline styles, colours
                                                      #   in markup, unknown blocks/options, unsafe links,
                                                      #   unlabelled sections; exit 1 on any problem
   theme=$(grep -o 'href="[^"]*\.vars\.css"' anchor.html)    # one theme for the whole set
   for f in *.html; do grep -qF "$theme" "$f" || echo "THEME DRIFT: $f"; done
   grep -n ':root *{\|#[0-9a-fA-F]\{3,8\}\b\|rgba\?(\|hsla\?(' *.html board.css   # hand colours or a token block
   grep -n 'data-theme' *.html                                                     # hand-made dark toggle
   grep -n 'action="http\|fetch(\|XMLHttpRequest' *.html                         # nothing wired live
   grep -in 'testimonial\|trusted by\|"[^"]\{20,\}" *[—-] *[A-Z]' *.html *.view.json  # fabricated proof smell
   ```

   The last four greps should print nothing (an entity like `&#35;` in text is fine; a `#1042` ticket number in prose is fine). Then the semantic pass, which no lint does: every number on the page is on the fact sheet or labelled illustrative; no invented customer, logo, quote, or metric; the claims match what the client actually does today; the resting state is readable; it holds at 375px; it reads in both modes if it's `auto`. Look at each page yourself — a subagent's "verified" covers mechanics, not meaning. Re-brief with specific fixes (max 2 retries).

7. **Publish centrally** — Build the Artifact bodies, check them, then publish each with the Artifact tool yourself:

   ```bash
   node kit/render.mjs pack anchor.html explainer-b.html calculator.html --out-dir out   # hand pages
   node kit/render.mjs playbook.view.json --host artifact -o out/playbook.artifact.html # each view
   node kit/render.mjs check out/*.artifact.html
   ```

   Both write the claude.ai page contract: `<title>` first, no doctype/`<html>`/`<body>`, everything inlined but Google Fonts. Mode follows the page: `data-mode="auto"` (or a view without `mode`) follows the viewer's light/dark choice, `light`/`dark` pin one look. Publish the `out/*.artifact.html` files, not the sources: consistent `icon` word per family (e.g. every explainer `chart`, every GTM page `page`), a one-sentence `description`, the `<title>` the page already carries. Don't call `open` on an artifact you just published — publishing already surfaces it. Record every file → URL pair as you go.

8. **Preserve and hand off** — Scratchpad files die with the session. Copy the whole set folder into the client repo (e.g. `collateral/<family>/`: `kit/`, the theme, `board.css`, sources, view specs and `out/`) with a `README.md` mapping file → Artifact URL, and note that republishing to the same URL from a new session means passing that artifact's `url` (and reading it first). The view specs and hand pages are the durable part; `out/` is a render cache. Report the set as a table: name, archetype, form (view or hand), theme and mode, URL, real vs illustrative content, open items.

9. **Go-live checklist** — Drafts are private and inert by design. Going live is a separate, explicit decision; list what it needs rather than doing it:
   - [ ] Which account publishes and shares (yours, the client's, a shared org) — artifacts are private by default; sharing is a deliberate step in the share menu.
   - [ ] Client sign-off on every real number and every claim.
   - [ ] Illustrative content replaced with real, or kept and still labelled.
   - [ ] Real form endpoints (ESP list, CRM) wired in place of `href="#"` mocks.
   - [ ] Real links: booking page, site, docs.
   - [ ] Long-term home: stays an artifact link, or ported to the client's domain.

## Guardrails

Paste these into every brief, verbatim.

- **Real facts only, from the fact sheet.** No number, customer, integration, certification, or capability that isn't on it.
- **Nothing fabricated as proof.** No invented customers, testimonials, quotes, logos, star ratings, or metrics.
- **Anything not real is labelled "illustrative" — at more than one level.** A page-level note ("Illustrative example — composite, not a specific customer"), the section heading or caption, and the individual figure. A screenshot of one section must still carry the label.
- **Illustrative names are generic.** "A regional lender", "Operator A" — never a plausible real company name.
- **Forms and CTAs are mock.** `href="#"`, `<form>` with no `action`, submit handler that only shows a local confirmation, and an HTML comment at each: `<!-- MOCK: needs real endpoint before go-live -->`.
- **Nothing wired live.** No analytics, no pixels, no network calls, no real email capture.
- **Kit and the theme, nothing else.** Copy the anchor's `<head>` links (fonts, theme, `kit/kit.css`, `kit/blocks.css`, `board.css`) and `data-mode` unchanged. Use kit blocks and bare HTML first. No `style=""`, no colour values anywhere (markup or CSS), no `:root` or token block, no `data-theme` toggle; page CSS reads theme vars only, scoped under `[data-kit]`. Every `<section>` has an `aria-label`. Never edit anything in `kit/`. Do not "improve" the system.

## Subagent brief template

```text
Build ONE page of a collateral set: {{ARTIFACT_NAME}} ({{ARCHETYPE}}).

READ FIRST
- Set folder (kit/, the theme, board.css live here): {{SET_DIR}}
- Anchor (how the set uses kit): {{ANCHOR_PATH}}
- Fact sheet (the only source of claims): {{FACT_SHEET_PATH}}
- Blocks: {{SET_DIR}}/kit/blocks.json (the 12 blocks, options, data) and kit/README.md
- {{ANY_OTHER_POINTER — e.g. a sibling page to match, a spec doc}}

FORM: {{"view spec" | "hand-built page"}}
- View spec: write {{NAME}}.view.json ("spec": 1, "title", "theme": "{{THEME_REF}}",
  "mode": "{{MODE}}", "blocks": [...]) using only blocks and options from kit/blocks.json.
  No HTML, no CSS. Render it: node kit/render.mjs {{NAME}}.view.json -o {{NAME}}.html
- Hand-built page: a whole document like the anchor. Copy the anchor's <head> links
  (fonts, theme, kit/kit.css, kit/blocks.css, board.css) and <html data-mode="{{MODE}}">
  unchanged. Kit blocks and bare HTML first; page CSS only for what no block covers, in
  one <style>, scoped under [data-kit], theme vars only (var(--primary), var(--card) ...).

DESIGN (both forms)
- No style="" attributes, no colour values anywhere, no :root/token block, no data-theme.
- Every <section> has an aria-label. <title>: 2–4 words, "{{TITLE}}".
- Readable at rest, motion only decorates, JS wrapped in try, holds at 375px.
- Never edit anything in kit/.
- Before returning: node kit/render.mjs check <your files> must print ok for each.

CONTENT
- Audience and job of this page: {{AUDIENCE_AND_JOB}}
- Sections, in order, and what each must prove:
  {{SECTION_LIST}}
- Real numbers to use (from the fact sheet): {{REAL_NUMBERS}}
- Illustrative content allowed: {{ILLUSTRATIVE_SCOPE | "none"}}

GUARDRAILS
{{PASTE THE GUARDRAILS SECTION VERBATIM}}

OUTPUT
- Write to: {{OUTPUT_PATH}} (in the set folder)
- Do NOT publish, open, pack, or share it — the orchestrator publishes.
- Return: the path, a one-line summary, the check output, every number used with its
  fact-sheet source or "illustrative", and anything you could not fill from the fact sheet.
```

## Archetype menu

| Archetype | Job | Needs from intake | Form | Build notes |
|---|---|---|---|---|
| **Motion explainer** | Show one mechanism working — a pipeline, an architecture, an access model | the real mechanism, 3–5 stages, 1–3 real numbers | hand | `board.css` stages and rails; numbers in a `stat-row`, legend in `chips`; CSS loops only; final resting state must say the point |
| **Pitch / transformation** | FROM → TO: the before-world and the after-world side by side | the pain in the customer's words; what changes; what it costs to switch | view, or hand if it animates | static: two `card-grid` columns or two `section`s; name the old tool/process plainly, no competitor-bashing |
| **Landing / funnel** | Convert a visitor: hero, problem, how it works, proof, CTA | ICP, top 3 pains, differentiators, CTA destination | view | `page-header` with `actions`, `step-list`, `card-grid` (plan cards), `callout` with the CTA; usually `light`; CTA `href` is `#` until go-live; proof real-only or omitted |
| **Interactive tool** | Let the prospect run their own numbers (ROI, savings, capacity) | the formula, defaults with sources, which inputs matter | hand | bare `<form>`/`<label>`/`<input>` (kit styles them) and a `stat-row` the script updates; loads **pre-filled in a working state**; every assumption visible and adjustable; shows its math; illustrative defaults labelled |
| **Proof / case study** | Tell one story of before → after with results | a real consented story, or explicit permission to write an illustrative composite | view | `callout` for the illustrative label, `stat-row`, `step-list`; labelled at page, section, and figure level; generic names; no quotes unless real and permitted |
| **Strategy doc / playbook** | The plan itself — positioning, channels, sequence, metrics | ICP, differentiators, channels available, constraints | view | `section`s holding `step-list`, `decision-list`, `data-table`, `action-list`; headings and tables do the structure |
| **Dashboard** | Show a live-feeling operating picture | real metrics and their shape, or sample data labelled as sample | view | `stat-row`, `data-table`, `record`, `chips`; charts from the `dataviz` skill embedded in a hand page; sample data labelled |

## Pitfalls

- **Writer agents can't write files.** In most setups `writer` has no Write tool, so the fan-out returns prose and you land ten files by hand. Route file-producing briefs to `coder` or `general-purpose`.
- **Don't `open` what you just published.** Publishing already shows it; an extra `open` is noise.
- **Mixed modes are fine across the set; mixed themes are not.** Landing pages can pin `light` and screen-share explainers `dark`, with the same theme on every page. A second theme in one set is the old drift with extra steps.
- **Artifacts are private by default.** Publishing is not sharing. The go-live step picks the account and uses the share menu.
- **An artifact `read` returns the packed page wrapped in the publish skeleton**, with kit and the theme inlined. Don't reuse it as an anchor: work from the set folder's sources (the hand pages and view specs), which is why step 8 keeps them.
- **Republishing needs the URL.** In the same session, republish by the same file path. From a new session, pass the artifact's `url` (read it first); a new path without `url` mints a new link and orphans the one the client has.
- **Scratchpad is session-scoped.** Copy sources into the repo before the session ends, or recovery means reading every artifact back and stripping wrappers.
- **Agents still reach for colours.** "Theme vars only" in the brief is not enough on its own — the kit lint catches a `style=""` or a colour in markup, and the step 6 grep catches a hex in a `<style>` block, which the lint doesn't read.
- **Page CSS that targets `body` breaks in the Artifact.** `pack` turns `<body data-kit>` into a `<div>` inside the platform's body. Style `[data-kit]`, never `body` or `:root`.
- **Illustrative labels get lost in excerpts.** Someone will screenshot the chart, not the page. Label at the figure level too.
- **Row-on-desktop, column-on-mobile flex boards collapse.** A `flex:1 1 0` item with `overflow:hidden` in a *column* flexbox shrinks to its padding — every stage becomes a 30px sliver at phone width while desktop looks perfect. Use `flex:none` by default and `flex:1 1 0` only inside the row breakpoint (the template does). A family built from one anchor inherits its bugs, so this is exactly what the 375px check must catch.
- **`--window-size=400` in headless Chrome lies.** The window has a minimum width (~500px), so the page lays out wider and the screenshot crops it. Check phone width by loading the page in a 375px-wide `<iframe>` inside a wrapper page, or with device emulation (Playwright's `viewport`).

## Notes

- **Sibling of `/motion-artifact`, not a replacement.** `/collateral-set` makes a family of live, published HTML pages whose motion is decorative CSS. When the user wants a **GIF, MP4, or WebM** of one of those scenes — a clip for Slack, a slide, a social post — hand off to `/motion-artifact`: port the scene's stages into its time-pure cue runtime and render. Don't screen-record a CSS loop; it won't be deterministic.
- **Refreshing the kit.** `kit/` is a pinned copy written by `rebel-kit sync`; `kit/kit.lock.json` names the version, rev and themes. To update it (or change the vendored themes), from the design-system checkout: `pnpm kit:sync <this skill>/kit [--themes a,b,c]`, then commit the folder. A set folder keeps the copy it was built with, so old sets don't shift under a kit update.
- `/orchestrate` is the general version of steps 4–6; this skill is that pattern specialised for visual collateral, where cohesion is the failure mode.
- `/report` is for one internal HTML report or dashboard, not a client-facing family.
- Anchor-first is also the right move with only three pages. Below three, just build them.
- Respect autonomy boundaries: publishing private drafts is fine; sharing, wiring real endpoints, or posting anywhere public is the user's call.
