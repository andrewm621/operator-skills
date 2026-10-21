# Adapter contract: <product name>

> What the product must provide for the spec to run. Five capabilities. Copy this file next to `spec.yaml` as `adapter.md`, then fill in the status and gaps. The spec does not depend on any particular technology; this file only says what has to exist.

- **Product and branch checked:**
- **Date checked:**

## Checklist
Tick a box only when it is true at the default branch today, and give the reference.

### 1. State store
Remembers each user's onboarding progress.
- [ ] Per user, stored on the server (not only in the browser)
- [ ] Versioned, so a changed spec can be applied to people already partway through
- [ ] Idempotent: recording the same step twice changes nothing
- [ ] Optional fallback to on-device storage, behind a flag
- **Where it would live / does live:**

### 2. Signal bus
Moves a step forward when something happens.
- [ ] A single call such as `emit(name, props)` that advances any step whose `completes_on` matches
- [ ] Called from the places the real action happens, not from the screen
- [ ] Safe to call twice and safe to call for a user with no onboarding state
- **Where:**

### 3. Event sink
Records the events in `spec.yaml` for measurement.
- [ ] A call such as `capture(name, props, distinctId)`
- [ ] Works on the server, so measurement does not depend on a browser setting
- [ ] Analytics and onboarding state are updated by one call, so they cannot drift apart
- **Where:**

### 4. Mailer
Sends the lifecycle emails.
- [ ] Sends by template id
- [ ] A scheduler that can run "after event, with delay, unless event"
- [ ] Suppression for the states listed in each email (for example activated, unsubscribed)
- [ ] A working unsubscribe link and a stored opt-out
- [ ] A once-only guard per email id and user
- **Where:**

### 5. UI surfaces
What the user sees.
- [ ] Intake question(s), shown at the right moment and skippable
- [ ] Checklist that reads the step registry and shows blocked states
- [ ] Tour host that reads versioned tours, offers them once and records the choice
- [ ] A permanent way to replay a tour
- **Where:**

## Gaps
One row per unticked box or missing event. Rank by what blocks the first segment.

| # | Capability | Gap | Smallest fix | Blocks first release? | Owner |
|---|---|---|---|---|---|
| 1 | | | | | |

## Events the spec needs that do not exist yet
| Event | When it should fire | Properties | Where to emit it |
|---|---|---|---|
| | | | |

## Approvals needed before launch
- [ ] Email sending (copy, volume, unsubscribe handling)
- [ ] Anything that changes billing or access
- [ ] Production release
