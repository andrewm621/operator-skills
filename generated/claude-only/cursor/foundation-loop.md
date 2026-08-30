# foundation-loop

Drive a fresh or near-fresh app from skeleton to a working foundation with minimal check-ins per round — not by looping forever, by stopping at a real, verified "done."

Task: {the text you type after the command}

## Steps

1. **Scope check — is this the right job for this skill.** `/foundation-loop` is for **standing up the boring, repetitive part of a new small app**: a fresh or near-fresh codebase (typically just out of `/scaffold`, or early enough that "the foundation" hasn't been proven yet) going from generated skeleton to a *working foundation* — nothing more. "Working foundation" means, concretely: the build/type-check/lint pipeline is clean, auth is wired end-to-end (signup or login → session persists → a protected route actually blocks the unauthenticated case), and **exactly one** core CRUD/data flow works end-to-end through the real stack (UI → API/server action → DB → back to UI). That's the whole bar — not a second feature, not visual polish, not test coverage beyond the smoke path. If the ask is a feature on a mature app, general open-ended building, or anything games-related, say so and point at `/orchestrate` (features) or `gauntlet-loop` (games) instead of stretching this skill to fit.

2. **Gather the brief.** From `{the text you type after the command}` and the repo:
   - Confirm the app directory. If no skeleton exists yet, stop and say so — this skill picks up *after* `/scaffold`, it doesn't generate the skeleton itself.
   - Read the repo's `CLAUDE.md`/README first for stack facts (framework, DB, auth provider, package manager) — don't re-derive what's already declared.
   - Pin down **the one core flow** to prove out — a single noun with a create+read loop (e.g., "todos," "invoices," "posts"). If `{the text you type after the command}` doesn't name one and it isn't obvious from the scaffold, ask one question before starting; picking the wrong flow wastes a full round.
   - Confirm the round ceiling (step 7) with the user up front if you're about to invoke `Workflow` — same opt-in requirement `/orchestrate` has for it.

3. **Decide the harness: `Workflow` tool vs. a prose `/loop`.** This is squarely the "loop until a condition" row in `/orchestrate`'s shape table (step 2 there), so `Workflow` is the **default** here, not an escalation. Concrete threshold:
   - Use the **`Workflow` tool** whenever you expect more than ~1 round, or the scope spans more than a single trivial wiring fix (auth *and* a data flow *and* a build gate is already three things to sequence with retries) — i.e., almost always.
   - Only stay in a simple prose loop when the scaffold is already ~90% there and this is realistically one pass (e.g., auth and the DB are already wired, only the one data flow is missing) — say explicitly why you're skipping `Workflow` if you do.
   - If using `Workflow`: **load the `workflow-authoring` skill before writing the script** — that's the reference for how Workflow scripts are actually authored in this environment. This skill specifies the harness *shape* (below); it does not hand you a finished script.
   - Workflow shape: a single sequential loop node (concurrency 1 — each round depends on the previous round's critique, there's nothing to parallelize across rounds), exit condition = step 7's pass bar, `max_iterations` = the ceiling from step 7, and a turn/token budget per round so one runaway round can't eat the whole ceiling.

4. **The round: implement → verify → critique → fix.** Each round is a discrete, bounded unit:
   1. **Implement** — a `coder` agent closes the specific gap (initial scope on round 1, the prior round's critique findings on later rounds). Give it the stack facts, the CLAUDE.md pointer, and the exact gap — not the whole brief every time.
   2. **Verify** (step 5) — real command output, not the builder's word.
   3. **Critique** (step 6) — a separate adversarial pass.
   4. If both verify and critique pass everything in step 7's bar: done, exit the loop. Otherwise, the critique's findings become next round's implement input, and the round counter increments.

5. **Verify means real output, not self-report.** Mirror `/orchestrate`'s rule: *"a subagent's 'verified, no issues' is not a visual QA gate"* — the same skepticism applies to functional correctness here. Verification is a separate step run by the harness (or a dedicated verifier agent with no stake in the implementation) that actually executes:
   - The build and type-check (`npm run build` / `tsc --noEmit`, per the project's own scripts) — capture the real exit code and output, not a paraphrase.
   - Lint, if the project has it wired.
   - The core flow and auth, **run**, not read — start the dev server (or use what's already running), hit the actual routes/actions, and confirm data really lands in and comes back from the DB. Reading the diff and concluding "this should work" does not satisfy this step.

6. **The adversarial critic tries to break it.** Borrowed from `gauntlet-loop`'s harsh-separate-critic mechanic, but bounded to functional correctness instead of open-ended visual polish. A separate `reviewer`-flavored agent, blind to how proud the implementer is of the diff, actually attempts (live, not hypothetically):
   - Bad/missing input on the core flow's entry point (empty required field, wrong type, an ID that doesn't exist) — does it fail gracefully or 500/crash?
   - A missing or blank required env var (comment one out from `.env.local`, restart) — does it fail with a clear error or die silently/cryptically?
   - Cold start — kill the dev server and bring it back up (or a fresh `.env` from `.env.example`) — does auth and the core flow still work without hand-holding?
   The critic reports pass/fail per attack, not a vibe. A "graceful, logged failure" on an edge case can be accepted as a known follow-up; a crash or silent data corruption cannot.

7. **Stop condition and hard ceiling — the anti-`gauntlet-loop` rule.** Unlike `gauntlet-loop`'s intentionally unreachable bar ("it will not finish by its own definition"), this skill is *supposed* to finish:
   - **Pass bar (the real "done"):** build/type-check/lint all green; auth demonstrably works end-to-end (session persists, protected route blocks unauth'd access); the one core flow demonstrably works end-to-end via an actual run; the critic's attacks are all either handled gracefully or explicitly accepted as a logged follow-up.
   - **Hard ceiling:** a real, finite `max_iterations` (default **5 rounds**, override via `{the text you type after the command}` or ask if unclear) and a turn/token budget per round. Hitting the ceiling without passing is a **stop, not a reason to keep going** — report exactly what's still failing and hand back a concrete gap list for a human decision. Never quietly extend the ceiling mid-run.

8. **Check-ins stay minimal by design.** Surface to Andrew only: at kickoff (confirm the one flow + the ceiling, and get `Workflow` opt-in if using it), if genuinely blocked on something only he can decide (a missing secret, an ambiguous requirement, a real external dependency), and at the end (passed, or ceiling hit). Do not report round-by-round — that reintroduces the exact back-and-forth this skill exists to remove.

9. **Report.**

   ```
   FOUNDATION-LOOP  <app> — <PASSED after N/max rounds | STOPPED at ceiling (N/N rounds)>

   Build/type-check/lint:  <clean | failing: ...>
   Auth:                   <working end-to-end | gap: ...>
   Core flow (<name>):     <working end-to-end | gap: ...>
   Critic findings:        <N attacks, N handled, N accepted follow-ups, N unresolved>

   Round log:
   [1] implement: <what changed> → verify: <pass/fail> → critique: <findings>
   [2] ...

   Remaining gaps (if stopped at ceiling): <concrete list, ready for a human decision>
   ```

## Notes
- Picks up **right after `/scaffold`** — `/scaffold` stops once the skeleton exists (it doesn't iterate, build, test, or fix); `/foundation-loop` is what takes that skeleton the rest of the way to a proven foundation. For a scaffold that's already fully wired, this skill is a no-op — say so rather than manufacturing rounds.
- This is the **pre-built, bounded harness for the one case `/orchestrate`'s own shape table (step 2) would otherwise send to an ad-hoc `Workflow` script** — reach for `/foundation-loop` directly instead of re-deriving the loop/verify/critique shape from scratch every time the job is "stand up a new app's foundation." For everything else that's loop-shaped but isn't this specific pattern (feature work, general fan-out), stay with `/orchestrate`'s graduation rule.
- Spiritual sibling of `gauntlet-loop`, deliberately inverted on the one axis that matters: `gauntlet-loop` is pure-prompt, games-only, and its bar is intentionally unreachable ("the human is the brake"); `/foundation-loop` is a genuine harness (`Workflow`-backed by default), scoped to apps, with a real pass bar *and* a hard ceiling so it stops on its own.
- Not for: feature work on a mature app (`/orchestrate`), visual/design polish (a `designer` pass, or `/invert` for red-teaming a flow), games (`gauntlet-loop`), or a single trivial fix (just do it — don't spin up a harness for one line).
- If the work should persist across sessions (e.g., handed off mid-loop, or run overnight), cross-reference `/maestro` the way `/orchestrate` does — persist the loop as a standing task rather than losing round history when the session ends.
- Load the `workflow-authoring` skill before writing the actual Workflow script (step 3) — this skill defines the harness shape, not the script syntax.
