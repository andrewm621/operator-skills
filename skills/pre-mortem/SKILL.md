---
name: pre-mortem
description: >
  Run a council-style pre-mortem on a decision, plan, or commitment before you make it. Spawns parallel devil's-advocate subagents — each a named advisor arguing ONLY the failure case from their own domain lens — and rolls up into a ranked "Causes of Death" report with kill-conditions, severity/likelihood, and concrete avoidance mitigations.
argument-hint: "a decision, plan, or commitment (e.g. \"should I sign this client\", \"should I take on this $40K retainer\", \"should I kill this project\")"
---

Run a pre-mortem: assume the decision has already failed, then work backward to find out why. Instead of weighing pros and cons, spawn independent advisor subagents that each argue ONLY how this specific decision kills you — from a different domain lens. Aggregate into a ranked "Causes of Death" report with concrete conditions to avoid each one.

Decision: $ARGUMENTS (a decision, plan, or commitment — e.g. a new client, a hire, a financial commitment, a restructure, a kill/keep call)

## Steps

1. **Parse the decision** — From `$ARGUMENTS`, determine:

   **a) What kind of decision this is:**
   - A deal/client (e.g., "should I sign this new client", "should I restructure this engagement")
   - A commitment (e.g., "should I take on this $40K retainer", "should I commit to this deadline")
   - A people decision (e.g., "should I hire this person", "should I let this person go")
   - A kill/keep call (e.g., "should I kill this project", "should I sunset this product")
   - A structural change (e.g., "should I change the pricing model", "should I bring on a partner")

   **b) Reversibility and stakes** — Is this a one-way door (hard/costly to undo) or two-way (cheap to reverse)? Higher stakes and lower reversibility mean the pre-mortem should be more aggressive and the final recommendation more conservative.

   **c) Gather context** — If the decision references a specific project, client relationship, or commitment that has a home in the vault/notes/context, read it before spawning advisors so they're arguing from real facts (current terms, capacity, timeline, money already on the table), not vibes. If the stakes or reversibility aren't clear from `$ARGUMENTS`, ask one grounding question before proceeding rather than guessing.

2. **Select the advisors** — Choose 5-7 from the roster below based on the decision type. Not every advisor applies to every decision — pick the ones whose kill-question actually bites:

   | Advisor | Domain Lens | Kill Question | Best For |
   |---------|-------------|----------------|----------|
   | **The Steward** | Burnout, human limits, relationship spillover | "How does this cost you your health, your household, or your team's trust before it costs you money?" | Big commitments, hires, anything that eats hours you don't have |
   | **Tommy (the Operator)** | Execution capacity, delivery triage | "What existing commitment quietly breaks because you said yes to this one?" | New clients, new projects, anything added to an already-full plate |
   | **Naval** | Leverage, opportunity cost, single-front focus | "What's the one compounding thing this distracts you from?" | Anything that splits focus across fronts |
   | **Jeff Bezos** | Long-term regret, irreversibility | "In three years, which choice do you regret — and can you even undo this one?" | One-way-door decisions: restructures, kills, hires, partnerships |
   | **Hormozi** | Cash velocity, margin, unit economics | "Where does cash actually stop flowing, and how fast do you find out?" | Deals, pricing changes, hires, anything with a burn rate |
   | **The Craftsman** | Delivery quality, reputation | "What ships broken, late, or embarrassing because this stretched you thin?" | Client work, anything with a visible deliverable |
   | **The Questioner** | Avoidance behavior, the dread-gate | "Are you actually saying yes to this, or avoiding a harder no?" | Decisions with a whiff of people-pleasing or conflict-avoidance |
   | **Tyrion** | Deal structure, leverage, exit terms | "Which term in this deal has no exit ramp if it goes wrong?" | Contracts, partnerships, hires, financial commitments |
   | **The Historian** | Precedent, pattern-matching | "What did the last three times you did something this shape actually teach you?" | Repeat-shape decisions — same client type, same hire type, same deal type |
   | **The Distributor** | Market exposure, GTM, reputation | "Who finds out you overcommitted, and what does it cost you with them?" | Public commitments, launches, anything visible outside the building |

   **Selection heuristic:**
   - New client / deal → Hormozi, Tommy, Tyrion, The Craftsman, The Steward
   - Hire / people decision → The Steward, Tommy, Hormozi, The Historian, Jeff Bezos
   - Kill/keep a project → Naval, Jeff Bezos, Hormozi, The Questioner, The Historian
   - Restructure / pricing / structural change → Tyrion, Hormozi, Naval, The Distributor, Jeff Bezos
   - Big financial or time commitment → The Steward, Hormozi, Tommy, The Questioner, Jeff Bezos

3. **Display the analysis plan** — Before spawning agents:

   ```
    PRE-MORTEM  It's [N months/years] from now. This decision killed you. Why?
    Decision: <subject>
    Stakes: <one-way door / two-way door> — <reversibility note>

    Spawning 6 advisors in parallel, each arguing ONLY how this kills you:

    [1] The Steward — "How does this cost you your health or household first?"
    [2] Tommy — "What existing commitment breaks because you said yes?"
    [3] Hormozi — "Where does cash stop flowing, and how fast do you find out?"
    [4] Tyrion — "Which term has no exit ramp if this goes wrong?"
    [5] The Craftsman — "What ships broken because you're stretched thin?"
    [6] The Questioner — "Are you saying yes, or avoiding a harder no?"

    Running in parallel. Results in ~30-60s.
   ```

4. **Spawn all advisors simultaneously** — Launch all selected advisors as parallel agents in a single message. Each agent gets a self-contained prompt:

   **Agent prompt template:**
   ```
   You are [ADVISOR NAME], sitting on a pre-mortem panel for a decision that
   hasn't been made yet.

   ## The Exercise
   Assume the decision below has already been made, and it has already killed
   the person who made it — cost them the money, the relationship, the health,
   or the reputation on the line. Your job is to explain EXACTLY how and why,
   from your domain lens, in your own voice. This is Charlie Munger's inversion
   principle applied to a decision instead of a system: don't ask how this
   succeeds, ask how it kills.

   ## Your Rule
   Argue ONLY the failure case. Do not give balanced pros and cons, do not
   praise the upside, do not hedge toward "it depends." If you can see a
   reason this works, that's someone else's job on this panel — your job is
   to find every way it doesn't.

   ## The Decision
   [Decision description + relevant context: current terms, capacity, timeline,
   money on the table, stakes/reversibility from Step 1]

   ## Your Lens: [ADVISOR NAME] — [DOMAIN LENS]
   Kill question: [Kill question from the table above]

   ## Instructions
   1. If there's relevant context to read (vault notes, project files, prior
      decisions), read it — ground your argument in real facts, not
      speculation.
   2. Identify 3-5 specific ways this decision kills the person, in your
      voice and from your lens.
   3. For each cause of death:
      - Give it a death-tier: FATAL, SEVERE, SURVIVABLE, MINOR
      - Describe the death scenario concretely — what happens, in what order
      - Name the trigger condition (the specific thing that sets it off)
      - Estimate likelihood: likely, possible, unlikely (but still fatal if it hits)
      - Give a concrete avoidance condition — not "be careful," but the exact
        term, cap, guardrail, or precondition that prevents this death
   4. Rank your own findings by death-tier × likelihood (FATAL + likely first).

   ## Output Format
   Return your findings as a structured list:

   ### [Advisor Name]'s Causes of Death

   **1. [DEATH-TIER] [Short title]**
   - Scenario: How this specific death unfolds
   - Trigger: What sets it off
   - Likelihood: likely/possible/unlikely
   - Avoidance condition: The specific guardrail that prevents it

   **2. [DEATH-TIER] ...**
   (continue for each finding)
   ```

   **When there's relevant context:** point the agent at the specific project home, client notes, or financial detail (retainer size, capacity numbers, contract terms) so the argument is grounded, not generic.

   **When the decision is abstract:** direct the agent to reason from the decision as stated and any conversation context — it should still stay in-voice and concrete, not vague.

5. **Aggregate results** — As advisors complete, merge all findings into a unified report. De-duplicate overlapping causes of death across advisors (e.g., if both Hormozi and Tommy flag the same capacity/cash-flow collision, merge them and note both caught it — that's a severity amplifier, not redundancy).

   **Ranking algorithm:**
   - FATAL + likely = Tier 1 (do not proceed without resolving this first)
   - FATAL + possible OR SEVERE + likely = Tier 2 (resolve before committing)
   - SEVERE + possible OR SURVIVABLE + likely = Tier 3 (name it as a guardrail, proceed with eyes open)
   - Everything else = Tier 4 (acknowledge, monitor)

6. **Present the Causes of Death report:**

   ```
    CAUSES OF DEATH  <decision>
    6 advisors consulted | N total causes of death found

    ═══════════════════════════════════════════════════
    TIER 1 — FATAL, do not proceed until resolved (N found)
    ═══════════════════════════════════════════════════

    1. [FATAL] No cash-flow floor on a delayed-payment client
       Advisors: Hormozi, Tyrion
       Scenario: Client is net-60 on a retainer sized to a chunk of monthly
                 revenue. One late invoice and payroll doesn't clear.
       Trigger: First missed or delayed payment cycle
       Likelihood: likely (this client's pattern, per prior engagement notes)
       Avoidance condition: No work begins without 50% upfront + a hard
                             kill-switch clause at 15 days late, in writing,
                             before signing.

    2. [FATAL] Capacity collision with an existing committed deadline
       Advisors: Tommy
       Scenario: Taking this on means someone already promised elsewhere
                 gets bumped without being told, and finds out from a missed
                 deadline instead of a conversation.
       ...

    ═══════════════════════════════════════════════════
    TIER 2 — SEVERE, resolve before committing (N found)
    ═══════════════════════════════════════════════════
    ...

    ═══════════════════════════════════════════════════
    TIER 3 — Name as a guardrail, proceed with eyes open (N found)
    ═══════════════════════════════════════════════════
    ...

    ═══════════════════════════════════════════════════
    TIER 4 — Acknowledge / monitor (N found)
    ═══════════════════════════════════════════════════
    ...

    ═══════════════════════════════════════════════════
    SYNTHESIS
    ═══════════════════════════════════════════════════

    | Tier | Count | Action |
    |------|-------|--------|
    | 1 — FATAL | 2 | Do not sign/commit until resolved |
    | 2 — SEVERE | 3 | Resolve first, or decline |
    | 3 — SURVIVABLE | 4 | Proceed, but name these guardrails out loud |
    | 4 — MINOR | 2 | Note and move on |

    Cross-cutting theme: 3 of the 6 advisors independently flagged the same
    capacity collision — that's not noise, that's the real risk.

    ═══════════════════════════════════════════════════
    RECOMMENDATION: [Proceed / Proceed with named guardrails / Do not proceed]
    ═══════════════════════════════════════════════════

    <One paragraph, in your own voice, stating the call and naming the
    specific conditions — if any — that make it safe to proceed.>
   ```

7. **Offer follow-up actions:**

   - "Resolve the Tier 1 findings before deciding?" → work through each kill-condition concretely
   - "Save this as a decision record?" → write to `dev-notes/decisions/YYYY-MM-DD-pre-mortem-<subject>.md`
   - "Re-run after terms change?" → re-run scoped to what changed (new contract terms, new capacity numbers)
   - "Run `/invert` too?" → if the decision has a technical/build component, pair a code-level inversion with this decision-level one

## Notes
- This is `/invert`'s sibling for decisions instead of code: same inversion principle (Munger's "invert, always invert"), same parallel-subagent structure, same tiered-severity report — but the subject is a decision/plan/commitment, not a codebase, and the advisors argue in first-person persona voice rather than as anonymous technical lenses. Use `/invert` when the thing being stress-tested is a feature, system, or process; use `/pre-mortem` when it's a decision, deal, hire, or commitment.
- This deliberately does **not** run a balanced multi-perspective deliberation. Andrew separately runs a council format for business/strategy decisions where a roster of named advisors each gives a genuine take (pros and cons both) and a chair synthesizes a recommendation — that's for "what should I do." `/pre-mortem` is single-purpose devil's advocate: every advisor argues only the failure case, on purpose, so the blind spots surface before the decision does. If you want the balanced version of this conversation, that's a different exercise — don't ask this skill to be both.
- Named advisors are a fixed voice roster, not a debate — each one stays in their lane (their domain lens) and doesn't rebut the others. Overlap between advisors on the same finding is a signal to weight it higher, not to merge it away entirely.
- For high-stakes, low-reversibility decisions (hires, partnerships, kills, restructures), be more conservative in the final recommendation — a Tier 2 finding on a one-way door deserves more weight than the same tier on something easily undone.
- 5-7 advisors is the sweet spot — fewer misses lenses that matter, more produces redundant kill-conditions without adding real signal.
- Named after Gary Klein's pre-mortem technique: instead of a post-mortem after failure, run the autopsy *before* the decision, while there's still time to change course.
- Can be re-run as terms change (a contract gets renegotiated, a capacity picture shifts) — the report becomes a living check before the ink is dry.
