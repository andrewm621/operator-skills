Enter a multi-round Socratic brainstorming session to deeply explore a project idea, then generate a phased roadmap with tasks, dependencies, and unknowns.

Topic: $ARGUMENTS

## Steps

1. **Initialize context** — Gather background before brainstorming:

   **a) Project detection:**
   - If `$ARGUMENTS` names a known project in `~/Projects/`, read its `CLAUDE.md` and `package.json` to understand the current state, stack, and existing features
   - If `$ARGUMENTS` is a feature within the current project (already cd'd into one), gather context from schema files, existing routes, components
   - If `$ARGUMENTS` is a greenfield idea, note that and skip codebase reading

   **b) Existing roadmaps:**
   - Check `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/roadmaps/INDEX.md`
   - If a roadmap already exists for this topic, tell the user and offer: revise the existing one, or create a new one

2. **Round 1 — Foundation questions (3-4 questions)**

   **YOU MUST use the `AskUserQuestion` tool** to present structured questions with selectable options. Do NOT just type questions as text — use the tool so the user gets the interactive survey UI.

   Present 3-4 questions in a SINGLE `AskUserQuestion` call. Adapt questions to the specific topic — don't use generic templates. Each question MUST have 2-4 concrete options with descriptions, plus the automatic "Other" for free-text.

   Example question topics (adapt to the specific `$ARGUMENTS`):
   - **End goal:** "What does 'done' look like for this project?" — Options: MVP/prototype, Production-ready v1, Full feature set, Iteration on existing
   - **Audience:** "Who is this primarily for?" — Options: End users/customers, Clients (white-label), Internal team, Open source community
   - **Starting point:** "What's the current state?" — Options: Greenfield (nothing exists), Prototype exists, Production app needs new feature, Rewrite/refactor of existing
   - **Timeline:** "What's the timeline pressure?" — Options: Hard deadline (specify in Other), Client commitment this month, Flexible/no deadline, ASAP

   **CRITICAL:** After calling AskUserQuestion, STOP and wait for answers. Do NOT continue to Round 2 until the user responds.

3. **Round 2 — Depth questions (3-4 questions)**

   Based on Round 1 answers, construct a SECOND `AskUserQuestion` call that digs deeper. Challenge assumptions and probe edges. Questions should directly reference what the user said in Round 1.

   Example question topics (adapt based on Round 1 answers):
   - **Alternatives:** "You chose X — have you considered these alternatives?" — Options based on what they said
   - **Dependencies:** "What external dependencies does this have?" — Options: None/self-contained, Third-party APIs (specify), Client approvals needed, Other team's work
   - **Risk tolerance:** "What happens if the hardest part takes 2x longer?" — Options: Cut scope to ship on time, Push the deadline, Ship without that feature, It's the core — can't skip it
   - **Scope:** "What could you cut and still ship something valuable?" — Options tailored to the specific feature areas discussed

   **Optionally spawn research:** If a question requires codebase investigation or external lookup (e.g., "Let me check how auth currently works in that project"), spawn an Explore subagent or `/research` agent in the background WHILE presenting the AskUserQuestion. The research runs in parallel with the user answering.

   **CRITICAL:** After calling AskUserQuestion, STOP and wait for answers. Do NOT continue to Round 3.

4. **Round 3 — Priorities & sequencing (2-3 questions)**

   Construct a THIRD `AskUserQuestion` call focused on sequencing and unknowns. Again, reference specific things from Rounds 1-2.

   Example question topics:
   - **Highest risk:** "Which area has the most uncertainty?" — Options derived from the feature areas discussed
   - **Build order:** "If you only had 2 days, what would you build first?" — Options: the 3-4 main feature areas identified so far
   - **Phase boundaries:** "Where are the natural phase boundaries?" — Options: Data layer first then UI, Vertical slice (one feature end-to-end), Infrastructure then features, Other

   For any question where the user needs to flag unknowns or add context beyond the options, remind them they can use "Other" to type freely.

   **CRITICAL:** After calling AskUserQuestion, STOP and wait for answers before synthesizing.

5. **Synthesize the roadmap** — After all rounds are complete, generate the roadmap document:

   **a) Generate YAML frontmatter:**
   ```yaml
   ---
   title: "<descriptive title>"
   slug: <kebab-case-slug>
   project: <project directory name or "multi" or "new">
   created: YYYY-MM-DD
   updated: YYYY-MM-DD
   status: active
   current_phase: 1
   phases_total: <N>
   tags: [relevant, tags]
   ---
   ```

   **b) Write the body:**
   ```markdown
   # Roadmap: <Title>

   ## Vision
   One paragraph describing the end state.

   ## Unknowns & Risks
   - [ ] Risk/unknown 1
   - [ ] Risk/unknown 2

   ---

   ## Phase 1: <Name>
   status: pending
   progress: 0/<N>

   ### Tasks
   - [ ] 1.1 Task description | priority:high | effort:M
   - [ ] 1.2 Task description | priority:medium | effort:S

   ### Dependencies
   - None (first phase) / List dependencies

   ### Notes
   - Any relevant context

   ---

   ## Phase 2: <Name>
   ...
   ```

   **Task guidelines:**
   - IDs are `phase.task` (e.g., 2.3 = Phase 2, Task 3)
   - Priority: high, medium, low
   - Effort: S (<1h), M (1-4h), L (4h+)
   - Keep tasks concrete and actionable — "Set up Stripe webhook handler" not "Handle payments"
   - 3-8 tasks per phase is ideal. If a phase has 10+, split it.

   **c) Save the brainstorm transcript:**
   Capture the key Q&A from all 3 rounds as `brainstorm.md` in the same directory.

6. **Save and index** — Write the files:
   - Create directory: `~/.claude/projects/-Users-andrewmiller-Projects/dev-notes/roadmaps/<slug>/`
   - Write `roadmap.md` (the roadmap)
   - Write `brainstorm.md` (the Q&A transcript)
   - Update `roadmaps/INDEX.md` — append a row: `| slug | project | active | 1/N | date | [roadmap](slug/roadmap.md) |`

7. **Present the roadmap** — Show the completed roadmap in a formatted view (similar to what `/phases` would render).

8. **Handoff** — Suggest next steps:
   - "Run `/phases <slug>` to see progress at any time"
   - "Run `/todo` to start working on Phase 1 tasks"
   - If there are unknowns: "Consider `/research <unknown>` to resolve open questions"

## Notes
- **MANDATORY: Use AskUserQuestion tool for ALL rounds.** Never just type questions as text output. The user must get the interactive survey UI with selectable options for every round.
- Each AskUserQuestion call should have 3-4 questions max (the tool's limit is 4). Each question needs 2-4 concrete options with descriptions.
- Wait for the user to respond to each AskUserQuestion before calling the next one. This means 3 separate turns minimum for the brainstorming phase.
- Adapt questions to the specific topic. A payments integration needs different questions than a design system overhaul. The example topics above are starting points — customize the actual question text, options, and descriptions for each roadmap.
- If the user says "skip to the roadmap" or "just generate it," respect that — synthesize from whatever context is available.
- This skill should feel like talking to a sharp technical co-founder who asks the hard questions, not filling out a form. The structured questions should still be insightful and challenging — the AskUserQuestion format makes them easier to answer, not easier to ask.
- If the topic spans multiple projects (e.g., "redesign the auth system across all apps"), note that in the frontmatter with `project: multi`.
- For very large scopes, suggest breaking into multiple roadmaps rather than one with 10+ phases.
- Multiple `/research` agents can run in parallel during brainstorming if there are several unknowns to investigate.
