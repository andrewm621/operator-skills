Design a product's onboarding and hand over a portable spec that a team can build from. Five phases, three human approval gates, no building.

Task: $ARGUMENTS

The output is an **Onboarding Spec**: `spec.yaml` (the structure, checked by a lint) plus `SPEC.md` (the reasoning, persona cards and open questions) plus `adapter.md` (what the product must provide to run it). The skill discovers the product, designs paths for each kind of user, has each path attacked by a critic playing that user, and stops at the spec.

**Mode is `spec-only`, always.** If asked to implement, wire up events, send an email or publish anything, decline and point at the "Notes for your team" section of the spec. Building belongs to the team that owns the product.

**The shipped onboarding contains no runtime AI.** Every word of copy is static text written now. Nothing in the spec may call for a model to generate, rank or personalise anything while a user is onboarding. AI is used to *design* the onboarding, not to *run* it.

## Steps

1. **Locate the package and set up the output folder.** The templates, schema and lint live next to this skill. Shell variables do not survive between Bash calls, so resolve the folder once, read the absolute path it prints, and **write that literal path into every later command** (written below as `<skill dir>`). Do not rely on a variable set earlier. First match wins: the folder this SKILL.md was loaded from, then the standard install locations, then a source checkout if you have one (`pwd -P` resolves symlinks to the real folder):

   ```bash
   PROJECTS="${PROJECTS:-$HOME/Projects}"   # use paths.projects from ~/.config/operator-skills/config.yaml if it differs
   for d in "<folder this SKILL.md was loaded from>" ~/.claude/skills/onboarding-spec \
            ./.claude/skills/onboarding-spec ~/.agents/skills/onboarding-spec \
            ~/.claude/skills/operator/onboarding-spec "$PROJECTS/operator-skills/skills/onboarding-spec"; do
     [ -f "$d/onboarding-spec.schema.json" ] && { (cd "$d" && pwd -P); break; }
   done
   ```

   Run it from the product repo's root so `./.claude/skills/onboarding-spec` resolves to `<repo>/.claude/skills/onboarding-spec`. If it prints nothing, ask where the `onboarding-spec` folder is. Do not reproduce the templates from memory.

   Output goes to `<product repo>/docs/onboarding/` unless the brief says otherwise (create it; nothing outside this folder is edited). If `$ARGUMENTS` points at a brief file, use it; if the folder already holds a `spec.yaml`, treat this as an update: read it first and say what will change.

2. **Phase 0, Brief.** Copy `<skill dir>/templates/brief.md` to `<out>/brief.md` and fill it from `$ARGUMENTS`, the repo's `CLAUDE.md` or README, and what the user has already said. Ask one question at a time, only for what cannot be found: product and repo, who signs up, scope, mode (always `spec-only`), voice, forbidden terms, and who approves each gate. Write "unknown" rather than guessing. No gate here; move straight on once the brief has a product, a repo and a forbidden-terms line (even if that line says "none").

3. **Phase 1, Discover.** Produce `<out>/discovery.md` from `templates/discovery.md`: a map of the product, the funnel today, which events exist and which are missing, and activation candidates. Run two read-only jobs in parallel and merge them:
   - **Code and product map** (`Explore` agent): how a new user gets from signup to first value, what onboarding already exists, where each event is emitted, with `path:line` references.
   - **Funnel and prior material** (`researcher` agent): any earlier onboarding plans, analytics exports, support threads and funnel numbers listed in the brief, and how the product's competitors onboard. Cited findings only.

   **Re-check every `path:line` reference at the default branch.** Earlier plans, notes and the researcher's own output are input, not truth: line numbers drift and events get renamed. Open each cited location at the default branch (`git fetch`, then read from `origin/<default>` rather than a possibly stale or dirty checkout) and record the commit and date checked. A reference that cannot be confirmed is marked `[unverified]` and not used as a premise. Separate what was checked from what was assumed, in every table.

   **Gate A. Stop and get approval** on four things, with a recommendation for each: the **activation event** (and whether an earlier "aha" milestone is tracked separately, for example when a paywall or an approval can sit between the two), the **segments**, the **baseline** (a real number with its source, or "not measured yet"), and the **target and cohort window**. Do not start Design until the user has answered. Record the decisions at the top of `discovery.md`.

4. **Phase 2, Design.** Two passes, with a gate between them.
   1. **Structure** (`planner` agent): segments, then one path per segment, then the step registry, tours, intake questions, events (marking each `exists: true/false` from discovery) and emails. Write it into `<out>/spec.yaml`, starting from `templates/spec.min.yaml` and adding only the optional sections the product needs. One registry: every surface reads the same steps. Steps complete on signals; `manual: true` needs a written `manual_reason`. Every blocked state says what to show. Tours are versioned data, offered once, with a permanent replay. Exactly one default segment, so nobody falls through. Run `node "<skill dir>/lint.mjs" <out>/spec.yaml` and fix errors before showing it.

      **Gate B. Stop and get approval of the structure before any copy is written.** Show segments, paths and the step list as a short table, plus the emails (trigger, delay, skip rule) and the events that would need adding. Rework here is cheap; rework after copy exists is not.
   2. **Copy** (`writer` agent): write every string in `copy.keys` in the voice from the brief. Static text only. Give it the approved structure, the voice rules and the forbidden terms, and have it return text for you to land in the YAML (if your writing agent can't write files, paste its text in yourself).

5. **Phase 3, Critic.** Attack the design before anyone reads it. Write one persona card per segment (`templates/persona-card.md`). Then run **one `reviewer` agent per segment**, each playing that person and walking their path step by step. Each critic reports, for its segment: dead ends (nothing tells the user what to do next), steps with no completion signal, gaps in branching (an answer or a situation no path covers), blocked states with no way forward, copy that assumes knowledge the persona does not have, and emails that would fire after the user has already done the thing. Alongside, run the lint with `--strict`.

   Fix what the critics and the lint find, then run them again. **At most 2 revise rounds.** If problems remain after round 2, stop revising and list what is left under open questions in `SPEC.md`. Do not loop further and do not quietly raise the limit. Keep each round's verdicts in the persona cards ("Walkthrough notes").

6. **Phase 4, Spec.** Assemble the package in `<out>/`:
   - `spec.yaml`: final, with `node "<skill dir>/lint.mjs" <out>/spec.yaml` passing (warnings explained or fixed).
   - `SPEC.md` from `templates/SPEC.md`: summary, activation and measurement, segments, persona cards, copy, events to add, open questions and **Notes for your team**.
   - `adapter.md` from `templates/ADAPTER.md`: fill the five-capability checklist and the gaps table from discovery, with references, so the team can see how far the product is from running the spec.

   **Scrub pass.** Grep the whole `<out>/` folder for every forbidden term in the brief, and for absolute home-directory paths and credentials. Then a `reviewer` agent reads the package cold, checks that nothing in it needs a runtime AI call and that every claim about the code carries a checked reference, and reports. Fix and re-check.

   **Gate C. Stop and ask for sign-off.** Present the file list, the lint result, the open questions and the events that need adding. Only after approval mark `SPEC.md` as approved with the date and the approver. The skill ends here.

7. **Report.**

   ```
   ONBOARDING-SPEC  <product>  v1.0  <APPROVED | DRAFT (gate pending)>

   Segments:    <n> (<ids>, default: <id>)
   Activation:  <event> within <N> days    Baseline: <value or not measured>
   Lint:        <PASS | FAIL> (<n> errors, <n> warnings)
   Critic:      <n> rounds, <n> findings fixed, <n> left as open questions
   Events to add: <n>      Open questions: <n>

   Files: <out>/brief.md, discovery.md, spec.yaml, SPEC.md, adapter.md
   Notes for your team: <the three things that block a first release>
   ```

## Agent roles and the inline fallback

| Phase | Role | Used for |
|---|---|---|
| Discover | `Explore` | Read-only search of the code for the product map and event sites |
| Discover | `researcher` | Prior material, funnel data, comparable products (cited) |
| Design | `planner` | Structure: segments, paths, steps, events, emails |
| Design | `writer` | Copy in the brief's voice |
| Critic, Spec | `reviewer` | One per segment as the persona; cold read in the scrub pass |

These are named agents available in some Claude Code setups. **If they are not available** (a different team's setup, or subagents turned off), do the same work yourself, inline and in the same order, and keep the separation that makes each role useful: build the product map before reading old plans; write the structure before the copy; and for the Critic phase, walk each segment's path as a separate, deliberate pass written from that persona's point of view, not as a general "looks fine". Where a role's tool is read-only, the output still has to be saved to the file named in each step. Say in the report which roles ran as agents and which ran inline.

When you do spawn agents, give each one the repo path, "read `CLAUDE.md` or the README first", the exact files to read (`brief.md`, `discovery.md`, `spec.yaml`), the output format wanted, and the forbidden terms. Launch independent ones in one message. Do not hand an agent the whole conversation. If `/orchestrate` is available, it has the general rules for fan-out and gating.

## Notes
- The three gates are human stops: A (activation, segments, baseline, target), B (structure before copy), C (final sign-off). If an approver is unavailable, leave the spec as a draft and say which gate is pending; never self-approve.
- **Checked vs. assumed.** Numbers, event locations and "this already exists" claims must say whether they were verified. An unverified figure stays out of the headline summary.
- **Email is the risky surface.** Every email needs a skip rule and an unsubscribe path; if the product has no unsubscribe handling, say so in `adapter.md` as a blocker for sending anything non-transactional. This skill never sends.
- **Keep the spec small.** Only `spec_version`, `product`, `activation`, `segments`, `steps`, `events` and `measurement` are required. Add `intake`, `tours`, `emails` and `copy` only when the product needs them. `templates/spec.min.yaml` is the starting point.
- **Lint.** `node "<skill dir>/lint.mjs" <spec.yaml> [--strict]` has no dependencies. It checks the file against `onboarding-spec.schema.json`; that every `completes_on` event and every email trigger or `unless` event is declared in `events`; exactly one default segment; a path for every non-default segment; every step a path mentions exists; `manual: true` carries a `manual_reason`; and, as warnings, copy keys that are not defined, steps no path uses and paths that never reach the activation event. Exit codes: 0 = pass, 1 = lint errors (or warnings with `--strict`), 2 = the file could not be read or parsed. `--json` prints how the YAML was read.
- **YAML subset.** The lint reads its own small YAML subset, so keep the spec plain:
  - Flow maps and lists (`{a: b}`, `[a, b]`) must stay on one line. A two-line flow map is a parse error (exit 2); write it as a block map instead.
  - No multi-line plain or quoted scalars. Use `|` (keep line breaks) or `>` (fold into one line) for long text.
  - Anchors, aliases, tags and multiple documents are rejected.
  - A `__proto__` key is rejected, and so is a duplicate key.
- `examples/tallyho.spec.yaml` is a complete spec for an invented invoicing app; use it to see the shape.
- Not for: rolling a product out to a customer's own team (this is first-run and lifecycle onboarding for a product's own users), building the onboarding (hand the spec to whoever owns the code), or one-off copy edits (just edit the copy).
- Related skills, if available: `/orchestrate` for fan-out and gating, `/research` for the funnel and comparison work, `/roadmap` to plan the build once the spec is approved.
