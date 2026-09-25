---
name: collateral-set
description: >
  Produce a cohesive set of client-facing HTML artifacts (explainers, pitch, landing page, calculator, case study, playbook) in one sitting — build one anchor by hand to lock the design system, fan the rest out to parallel subagents, gate every page for accuracy and cohesion, and publish them centrally as live Artifacts.
argument-hint: "<client> [archetypes, e.g. 'explainers x3 + landing + calculator']"
---

Produce a cohesive set of client-facing HTML artifacts in one sitting: anchor first, parallel fan-out, central gate and publish.

Request: $ARGUMENTS

Use this when a client or product needs *several* polished pages that must read as one family — a handful of motion explainers for a sales conversation, plus go-to-market pieces (landing page, ROI calculator, waitlist, case study, playbook). One page is a normal artifact request; this skill is for five to ten of them without the set drifting into five to ten different looks.

## The one idea that makes this work

**Cohesion comes from a file, not from a description.** Parallel agents given a *written* style brief each reinvent it slightly — a different grey, a different heading size, a different card radius — and the set falls apart. Given a *finished page* to copy tokens and components from verbatim, they converge. So you build one page by hand, get the look approved, and only then fan out. Everything downstream copies that file.

Only two inputs change per client: **brand tokens** and a **fact sheet**. The anchor structure, the brief template, the guardrails, and the gate are client-agnostic.

## Steps

1. **Intake** — Settle these before building anything. Ask for what's missing; don't invent it.

   | Input | Where it comes from | Default if absent |
   |---|---|---|
   | Brand tokens (colours, type pairing) | client site, brand guide, their app's CSS | derive a palette from their logo/site and say so |
   | Fact sheet | `templates/fact-sheet.md`, filled from real sources (calls, docs, repo) | **no default** — without it, every number is "illustrative" |
   | Archetypes and count | the request; see the [archetype menu](#archetype-menu) | 3 explainers + 1 landing |
   | Theme per archetype | brand + audience | explainers committed-dark, landing/funnel light |
   | Audience and use | who sees it, where (call screen-share, email, site) | sales conversation, shared by link |

   Write the fact sheet to disk (e.g. `collateral/fact-sheet.md` in the client repo) — every subagent will read it. Mark each number *real* (with source) or *illustrative*.

2. **Build the anchor by hand** — Copy `templates/anchor.html` (next to this skill; in the operator-skills repo at `skills/collateral-set/templates/`). Swap the token block values and the font `<link>` for the client, then fill it with the strongest real content you have — usually the core mechanism explainer. Do this yourself, not via a subagent: the anchor is the design decision, and you need to have looked at it.

   The anchor must satisfy the **artifact contract**, because every sibling will inherit it:
   - No doctype / `<html>` / `<head>` / `<body>`; the page starts at `<title>`.
   - `<title>` first, 2–4 words, a name ("Consensus Extraction"), not "Name: explainer".
   - Either full light/dark theme tokens, or one **committed** theme painted explicitly on `body` (plus `color-scheme`). Never half of each.
   - Readable at rest — all content in HTML; motion decorates. JS optional and wrapped in `try`.
   - `@media (prefers-reduced-motion: reduce)` kills all animation.
   - Responsive to ~400px with a ≥16px gutter and no horizontal scroll.
   - Google Fonts only; everything else inline; self-contained.

   Its `:root` block, font `<link>`, and component classes *are* the design system. Keep token **names** semantic (`--accent`, `--good`, `--flag`) so a light variant is a value swap, not a rename.

3. **Confirm the look** — Publish the anchor alone (step 7 mechanics) and show it to the user. Get an explicit yes on palette, type, and density *before* fanning out. Re-skinning one page is cheap; re-skinning nine is the whole job again.

4. **Write the briefs** — One per remaining artifact, using the [subagent brief template](#subagent-brief-template). Each brief carries: the anchor path, the fact-sheet path, the archetype, a content spec (sections, what each proves, which real numbers go where), the theme, the guardrails verbatim, and an output path. Name *which* real numbers each page may use — agents under-use a fact sheet they merely have access to.

5. **Fan out** — Spawn all briefs in one message, in parallel, in the background. Route to an agent that **can write files** — `coder` or `general-purpose`. The `writer` agent is read-only in most setups: it returns text and you end up landing the files yourself. Past ~5 visible agents or with retry logic, graduate to the Workflow tool per `/orchestrate`.

   Subagents **write files only**. They do not publish, open, or share — the orchestrator publishes, so titles, icons, and descriptions stay consistent and nothing goes out ungated.

6. **Gate every page** — Before publishing, check each file. Mechanical checks first, then look at it:

   ```bash
   # tokens and fonts copied verbatim from the anchor
   extract() { awk '/:root\{/{f=1} f{print} f&&/\}/{exit}' "$1"; }
   fonts=$(grep -o 'https://fonts.googleapis.com/css2[^"]*' anchor.html)
   for f in out/*.html; do
     diff -q <(extract anchor.html) <(extract "$f") >/dev/null || echo "TOKENS DRIFT: $f"
     grep -qF "$fonts" "$f"            || echo "FONT LINK DRIFT: $f"
     head -1 "$f" | grep -q '^<title>' || echo "TITLE NOT FIRST: $f"
   done
   grep -il '<!doctype\|<html\|<body' out/*.html                              # wrapper leaked in
   grep -L 'prefers-reduced-motion' out/*.html
   grep -n 'action="http\|fetch(\|XMLHttpRequest' out/*.html                  # nothing wired live
   grep -in 'testimonial\|trusted by\|"[^"]\{20,\}" *[—-] *[A-Z]' out/*.html  # fabricated proof smell
   ```

   A light-theme landing page legitimately differs in token **values** — diff its token **names** instead. Then the semantic pass, which no grep does: every number on the page is on the fact sheet or labelled illustrative; no invented customer, logo, quote, or metric; the claims match what the client actually does today; the resting state is readable; it holds at 400px. Look at each page yourself — a subagent's "verified" covers mechanics, not meaning. Re-brief with specific fixes (max 2 retries).

7. **Publish centrally** — Publish each page with the Artifact tool yourself: consistent `icon` word per family (e.g. every explainer `chart`, every GTM page `page`), a one-sentence `description`, the `<title>` the page already carries. Don't call `open` on an artifact you just published — publishing already surfaces it. Record every file → URL pair as you go.

8. **Preserve and hand off** — Scratchpad files die with the session. Copy every source into the client repo (e.g. `collateral/<family>/<name>.html`) with a `README.md` mapping file → Artifact URL, and note that republishing to the same URL from a new session means passing that artifact's `url` (and reading it first). Report the set as a table: name, archetype, URL, real vs illustrative content, open items.

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
- **Reuse the anchor verbatim.** Copy its `:root` block, font `<link>`, and component classes unchanged. Add only content-specific classes, named for this page. Do not "improve" the system.

## Subagent brief template

```text
Build ONE self-contained HTML artifact: {{ARTIFACT_NAME}} ({{ARCHETYPE}}).

READ FIRST
- Anchor (the design system): {{ANCHOR_PATH}}
- Fact sheet (the only source of claims): {{FACT_SHEET_PATH}}
- {{ANY_OTHER_POINTER — e.g. a sibling page to match, a spec doc}}

DESIGN
- Copy the anchor's :root token block, font <link>, and component classes VERBATIM.
  Add only content-specific classes. Do not change existing token names or values.
- Theme: {{THEME: "committed dark, same values as anchor" | "light variant: keep every
  token NAME, remap VALUES as in the anchor's LIGHT VARIANT note"}}.
- Same contract as the anchor: starts at <title> (2–4 words: "{{TITLE}}"), no doctype/
  html/head/body, readable at rest, prefers-reduced-motion, works at 400px with a
  >=16px gutter, Google Fonts only, everything inline.

CONTENT
- Audience and job of this page: {{AUDIENCE_AND_JOB}}
- Sections, in order, and what each must prove:
  {{SECTION_LIST}}
- Real numbers to use (from the fact sheet): {{REAL_NUMBERS}}
- Illustrative content allowed: {{ILLUSTRATIVE_SCOPE | "none"}}

GUARDRAILS
{{PASTE THE GUARDRAILS SECTION VERBATIM}}

OUTPUT
- Write to: {{OUTPUT_PATH}}
- Do NOT publish, open, or share it — the orchestrator publishes.
- Return: the path, a one-line summary, every number used with its fact-sheet
  source or "illustrative", and anything you could not fill from the fact sheet.
```

## Archetype menu

| Archetype | Job | Needs from intake | Build notes |
|---|---|---|---|
| **Motion explainer** | Show one mechanism working — a pipeline, an architecture, an access model | the real mechanism, 3–5 stages, 1–3 real numbers | the anchor's board/stage/rail components; CSS loops only; final resting state must say the point |
| **Pitch / transformation** | FROM → TO: the before-world and the after-world side by side | the pain in the customer's words; what changes; what it costs to switch | two columns or a split that animates across; name the old tool/process plainly, no competitor-bashing |
| **Landing / funnel** | Convert a visitor: hero, problem, how it works, proof, CTA | ICP, top 3 pains, differentiators, CTA destination | usually light theme; CTA is a mock; proof section is real-only or omitted |
| **Interactive tool** | Let the prospect run their own numbers (ROI, savings, capacity) | the formula, defaults with sources, which inputs matter | loads **pre-filled in a working state**; every assumption visible and adjustable; shows its math; illustrative defaults labelled as such |
| **Proof / case study** | Tell one story of before → after with results | a real consented story, or explicit permission to write an illustrative composite | illustrative-labelled at page, section, and figure level; generic names; no quotes unless real and permitted |
| **Strategy doc / playbook** | The plan itself — positioning, channels, sequence, metrics | ICP, differentiators, channels available, constraints | long-form reading layout from the same tokens; a table of contents; headings and tables do the structure |
| **Dashboard** | Show a live-feeling operating picture | real metrics and their shape, or sample data labelled as sample | tiles and charts from the anchor's readout components; load the `dataviz` skill if charting; sample data labelled |

## Pitfalls

- **Writer agents can't write files.** In most setups `writer` has no Write tool, so the fan-out returns prose and you land ten files by hand. Route file-producing briefs to `coder` or `general-purpose`.
- **Don't `open` what you just published.** Publishing already shows it; an extra `open` is noise.
- **Mixed themes are fine across the set, fatal within a page.** Landing pages read better light; explainers work committed-dark for screen-share. Same token *names*, same type pairing, different values. Decide per archetype at intake.
- **Artifacts are private by default.** Publishing is not sharing. The go-live step picks the account and uses the share menu.
- **An artifact `read` returns the page wrapped in the publish skeleton** (`<!doctype html><html><head>…reset <style>…</head><body>` … `</body></html>`). The authored content starts at `<title>`. Strip the wrapper before reusing a published page as an anchor or template, or every sibling inherits a nested document.
- **Republishing needs the URL.** In the same session, republish by the same file path. From a new session, pass the artifact's `url` (read it first); a new path without `url` mints a new link and orphans the one the client has.
- **Scratchpad is session-scoped.** Copy sources into the repo before the session ends, or recovery means reading every artifact back and stripping wrappers.
- **Agents drift the tokens anyway.** "Verbatim" in the brief is not enough on its own — the token diff in step 6 catches the agent that nudged `--line` two shades lighter.
- **Illustrative labels get lost in excerpts.** Someone will screenshot the chart, not the page. Label at the figure level too.
- **Row-on-desktop, column-on-mobile flex boards collapse.** A `flex:1 1 0` item with `overflow:hidden` in a *column* flexbox shrinks to its padding — every stage becomes a 30px sliver at phone width while desktop looks perfect. Use `flex:none` by default and `flex:1 1 0` only inside the row breakpoint (the template does). A family built from one anchor inherits its bugs, so this is exactly what the 400px check must catch.
- **`--window-size=400` in headless Chrome lies.** The window has a minimum width (~500px), so the page lays out wider and the screenshot crops it. Check phone width by loading the page in a 390px-wide `<iframe>` inside a wrapper page, or with device emulation.

## Notes

- **Sibling of `/motion-artifact`, not a replacement.** `/collateral-set` makes a family of live, published HTML pages whose motion is decorative CSS. When the user wants a **GIF, MP4, or WebM** of one of those scenes — a clip for Slack, a slide, a social post — hand off to `/motion-artifact`: port the scene's stages into its time-pure cue runtime and render. Don't screen-record a CSS loop; it won't be deterministic.
- `/orchestrate` is the general version of steps 4–6; this skill is that pattern specialised for visual collateral, where cohesion is the failure mode.
- `/report` is for one internal HTML report or dashboard, not a client-facing family.
- Anchor-first is also the right move with only three pages. Below three, just build them.
- Respect autonomy boundaries: publishing private drafts is fine; sharing, wiring real endpoints, or posting anywhere public is the user's call.
