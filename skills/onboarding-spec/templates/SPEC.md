# Onboarding spec: <product name>

> The narrative that sits next to `spec.yaml`. The YAML is the source of truth for structure and is checked by the lint; this file explains why, introduces the personas and lists what is still open. Where the two disagree, fix this file.

- **Spec version:** 1.0
- **Status:** draft / approved on <date> by <name>
- **Mode:** spec-only (nothing in this package builds anything)

## 1. Summary
Three to five sentences: who the product is for, the activation moment, and the shape of the onboarding (for example "one question, a checklist, one tour, two emails").

## 2. Activation and measurement
- **Activation event:** `<event>`, within <N> days of signup
- **Earlier milestone tracked separately:** `<event>` (and why it is separate)
- **Baseline:** <number, source, period, or "not measured yet">
- **Target and cohort window:**
- **Funnel:** `<event>` > `<event>` > `<event>`

## 3. Segments and paths
| Segment | Who | Path (step ids) |
|---|---|---|
| | | |

Why the segments were drawn this way, and what the default segment does for people who skip the question.

## 4. Persona cards
One card per segment, using `persona-card.md`. Paste them here or link to the files.

## 5. Steps, tours and emails
Anything the YAML cannot say on its own: the reasoning for the order of steps, why a tour is offered once, why an email waits 24 hours.

## 6. Copy
The voice rules, and the full text of every key in `copy.keys` where reviewers need to read it in one place.

## 7. Events to add
Events the spec relies on that the product does not emit today (`exists: false`), with when each should fire and its properties.

## 8. Rules this spec follows
- All copy is static. Nothing in the shipped onboarding calls an AI model at runtime.
- Steps are completed by signals, not by manual ticks, except where a written reason says otherwise.
- Every blocked state says what to show, so a progress counter never gets stuck.

## 9. Open questions
| # | Question | Who can answer | Needed before |
|---|---|---|---|
| 1 | | | |

## 10. Notes for your team
This skill stops at the spec. To build it, your team needs:
1. **Review** `spec.yaml`, this file and the persona cards.
2. **Fill in `adapter.md`.** It lists the five things the product must provide and where each one stands today.
3. **Add the missing events** from section 7.
4. **Build behind a flag**, one segment first, with the activation event mocked in tests and no live AI calls.
5. **Check the result** against the baseline over the cohort window in section 2.
6. **Re-run this skill** on the live product after launch to update the spec.

Anything that sends email, publishes, spends money or ships to production needs a person's approval first.
