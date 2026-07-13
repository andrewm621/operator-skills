Apply the inversion principle to stress-test a feature, process, or system. Instead of asking "how do we make this succeed?", spawns independent subagents that each ask "how would this fail?" from a different lens. Aggregates weaknesses into a prioritized risk report.

Subject: $ARGUMENTS (a feature, workflow, system, codebase area, or business process)

## Steps

1. **Parse the subject** — From `$ARGUMENTS`, determine:

   **a) What's being inverted:**
   - A feature (e.g., "the checkout flow", "event registration")
   - A system (e.g., "our auth architecture", "the cron job pipeline")
   - A process (e.g., "our deploy workflow", "onboarding new users")
   - A codebase area (e.g., "the Stripe integration", "the database schema")
   - A plan or proposal (e.g., "the roadmap for agencyos v2")

   **b) Scope the investigation:**
   - If the subject names a project or feature, identify the relevant project directory
   - If it references a roadmap, find it in `dev-notes/roadmaps/`
   - If it's abstract (a process, a business model), note that — agents will reason rather than read code

2. **Select the failure lenses** — Choose 4-5 lenses based on the subject type. Not all lenses apply to every subject — pick the most relevant ones:

   | Lens | Inverted Question | Best For |
   |------|------------------|----------|
   | **Technical** | "What breaks under load, edge cases, or bad data?" | Features, systems, APIs |
   | **User Experience** | "Where does the user get confused, frustrated, or stuck?" | Flows, features, onboarding |
   | **Security** | "How would an attacker exploit this?" | Auth, payments, data, APIs |
   | **Operational** | "What fails at 3am with no one watching?" | Cron jobs, deploys, infra |
   | **Data Integrity** | "How does data get corrupted, lost, or inconsistent?" | Schemas, migrations, sync |
   | **Business/Product** | "Why would a customer stop using this or choose a competitor?" | Features, pricing, UX |
   | **Scale** | "What breaks at 10x current usage?" | Architecture, DB, queues |
   | **Dependency** | "What happens when a third-party service goes down?" | Integrations, APIs, auth |
   | **Team/Process** | "Where does handoff fail or knowledge get lost?" | Workflows, documentation |
   | **Temporal** | "What breaks in 6 months when context is forgotten?" | Tech debt, conventions, config |

   **Selection heuristic:**
   - Technical features → Technical, UX, Security, Data Integrity, Scale
   - User-facing flows → UX, Technical, Business, Dependency, Temporal
   - Infrastructure/ops → Operational, Scale, Dependency, Security, Temporal
   - Business processes → Business, UX, Team/Process, Temporal, Dependency
   - Plans/roadmaps → Business, Technical, Temporal, Team/Process, Scale

3. **Display the analysis plan** — Before spawning agents:

   ```
    INVERT  Stress-testing: <subject>

    Spawning 5 failure analysts in parallel:

    [1] Technical Failure — "What breaks under edge cases and bad data?"
        Scope: reading <relevant files/dirs>

    [2] User Experience Failure — "Where does the user get confused or stuck?"
        Scope: analyzing the flow from user's perspective

    [3] Security Failure — "How would an attacker exploit this?"
        Scope: reviewing auth, input validation, data exposure

    [4] Data Integrity Failure — "How does data get corrupted or lost?"
        Scope: examining schema, transactions, race conditions

    [5] Scale Failure — "What breaks at 10x usage?"
        Scope: evaluating queries, caching, bottlenecks

    Running in parallel. Results in ~30-60s.
   ```

4. **Spawn all agents simultaneously** — Launch all selected lenses as parallel agents in a single message. Each agent gets a self-contained prompt:

   **Agent prompt template:**
   ```
   You are a failure analyst examining a system through the lens of [LENS NAME].

   ## Your Role
   You are a pessimist — your job is to find weaknesses, not strengths. Think like
   someone who wants this to fail. Apply the inversion principle: instead of asking
   how this succeeds, identify every way it could fail.

   ## Subject
   [Subject description + relevant context from conversation]

   ## Working Directory
   [Project directory if applicable]

   ## Your Lens: [LENS NAME]
   Core question: [Inverted question from the table above]

   ## Instructions
   1. If there's a codebase, read the relevant files to ground your analysis in reality.
      Don't speculate about what the code does — read it.
   2. Identify 3-7 specific weaknesses, vulnerabilities, or failure modes.
   3. For each weakness:
      - Give it a severity: CRITICAL, HIGH, MEDIUM, LOW
      - Describe the failure scenario concretely (not vaguely)
      - Explain the trigger condition (what causes it to happen)
      - Estimate likelihood: likely, possible, unlikely (but impactful)
      - Suggest a specific mitigation (not just "add error handling" — say exactly what)
   4. Rank findings by severity * likelihood (CRITICAL+likely first).

   ## Output Format
   Return your findings as a structured list:

   ### [Lens Name] Failures

   **1. [SEVERITY] [Short title]**
   - Scenario: What happens
   - Trigger: What causes it
   - Likelihood: likely/possible/unlikely
   - Mitigation: Specific fix
   - Files: relevant file paths (if code-based)

   **2. [SEVERITY] ...**
   (continue for each finding)
   ```

   **For code-based subjects:** Direct the agent to read specific files (schema, routes, components, middleware) relevant to its lens.

   **For abstract subjects:** Direct the agent to reason from first principles and the conversation context. It can still read project docs (CLAUDE.md, roadmaps) for grounding.

5. **Aggregate results** — As agents complete, merge all findings into a unified report. De-duplicate overlapping findings across lenses (e.g., if both Security and Technical flag the same race condition, merge them and note both lenses caught it).

   **Ranking algorithm:**
   - CRITICAL + likely = tier 1 (fix immediately)
   - CRITICAL + possible OR HIGH + likely = tier 2 (fix soon)
   - HIGH + possible OR MEDIUM + likely = tier 3 (plan to fix)
   - Everything else = tier 4 (monitor / accept risk)

6. **Present the inversion report:**

   ```
    INVERSION REPORT  <subject>
    5 lenses analyzed | N total weaknesses found

    ═══════════════════════════════════════════════════
    TIER 1 — Fix Immediately (N findings)
    ═══════════════════════════════════════════════════

    1. [CRITICAL] Race condition in event registration capacity check
       Lenses: Technical, Data Integrity
       Scenario: Two users register simultaneously when 1 spot remains.
                 Both pass the capacity check, both get registered,
                 event goes over capacity.
       Trigger: Concurrent requests to /api/events/register
       Likelihood: likely (happens under normal traffic)
       Mitigation: Use a database transaction with SELECT FOR UPDATE
                   on the event row, or use an atomic decrement:
                   UPDATE events SET spots = spots - 1 WHERE spots > 0
       Files: app/api/events/register/route.ts:34

    2. [CRITICAL] No webhook signature verification on Stripe endpoint
       Lenses: Security
       Scenario: Attacker sends fake webhook payloads to grant
                 themselves premium access.
       ...

    ═══════════════════════════════════════════════════
    TIER 2 — Fix Soon (N findings)
    ═══════════════════════════════════════════════════

    3. [HIGH] User sees blank screen if Clerk goes down
       Lenses: Dependency, UX
       Scenario: Clerk outage causes middleware to throw,
                 every page returns 500.
       Trigger: Clerk service degradation (has happened 2x in 2025)
       Likelihood: possible
       Mitigation: Add try/catch in proxy.ts, fall back to cached
                   session or show maintenance page.
       Files: proxy.ts:12

    ...

    ═══════════════════════════════════════════════════
    TIER 3 — Plan to Fix (N findings)
    ═══════════════════════════════════════════════════

    ...

    ═══════════════════════════════════════════════════
    TIER 4 — Monitor / Accept Risk (N findings)
    ═══════════════════════════════════════════════════

    ...

    ═══════════════════════════════════════════════════
    SUMMARY
    ═══════════════════════════════════════════════════

    | Tier | Count | Action |
    |------|-------|--------|
    | 1 — Fix immediately | 2 | Block shipping until resolved |
    | 2 — Fix soon | 3 | Address this sprint |
    | 3 — Plan to fix | 4 | Add to backlog |
    | 4 — Accept risk | 2 | Document and monitor |

    Cross-cutting themes:
    - Concurrency: 3 findings relate to race conditions (Technical + Data)
    - Dependency: 2 findings involve third-party service failures
    - Missing error states: UX lens found 2 unhandled error paths

    Strongest area: Security (only 1 finding, well-handled overall)
    Weakest area: Data Integrity (4 findings, several likely)
   ```

7. **Offer follow-up actions:**

   - "Fix tier 1 issues now? I can start with the race condition." → dispatch `/subagent`
   - "Create roadmap tasks for tiers 2-3?" → integrate with `/todo add`
   - "Save this report?" → write to `dev-notes/decisions/YYYY-MM-DD-inversion-<subject>.md`
   - "Run `/invert` again after fixes to verify?" → re-run scoped to fixed areas
   - "Deep-dive a specific finding?" → spawn focused research agent

## Notes
- The power of this skill is **parallel independent analysis** — each agent sees the same system through a different failure lens, catching blind spots that a single perspective would miss.
- Agents should READ CODE when available, not just reason abstractly. Grounded findings with file:line references are far more actionable than vague concerns.
- De-duplication is important: when multiple lenses flag the same issue, that's a signal of severity, not redundancy. Merge the findings but note "caught by N lenses" as a severity amplifier.
- For abstract subjects (business processes, plans), agents reason from first principles. The report is still structured the same way.
- 4-5 agents is the sweet spot. Fewer than 4 misses perspectives; more than 6 produces too much overlap and noise.
- This skill is inspired by Charlie Munger's inversion principle: "Invert, always invert." Tell me where I'm going to die so I never go there.
- The report should feel like a red team exercise — the agents are adversaries trying to break the system, not consultants being polite about risks.
- This pairs naturally with: `/pr-review` (inversion before merge), `/roadmap` (inversion on a plan), `/project-health` (inversion adds the "why" to the diagnostic "what").
- Can be re-run after fixes to verify improvements — the report becomes a living audit trail.
