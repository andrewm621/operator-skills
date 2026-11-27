# <Project name>

<!-- agent-pack:begin about -->
<!-- agent-pack: <date> @ <sha> -->
<2–3 lines: what this is, who uses it, where it runs.>
<!-- agent-pack:end about -->

## Setup
<!-- agent-pack:begin setup -->
- Runtime: <node 22 / python 3.12 / …>
- Install: `<command>` (not run)
- Local secrets live in `<file>` (never commit, never print)
<!-- agent-pack:end setup -->

## Commands
<!-- agent-pack:begin commands -->
| Do | Command | Status |
|---|---|---|
| Dev server | `<cmd>` | (not run) |
| Typecheck | `<cmd>` | (ran ok <date>) |
| Test | `<cmd>` | (not run) |
| Build | `<cmd>` | (not run) |
<!-- agent-pack:end commands -->

## Deploy
<!-- agent-pack:begin deploy -->
<How it ships, which account/target, who runs it. Agents never deploy without an explicit ask.>
<!-- agent-pack:end deploy -->

## Conventions
<!-- agent-pack:begin conventions -->
- <naming, file layout, error handling, style rules the code actually follows>
<!-- agent-pack:end conventions -->

## Never do
<!-- agent-pack:begin never -->
- <touch production data / print secrets / edit generated files / …>
<!-- agent-pack:end never -->

## Gotchas
<!-- agent-pack:begin gotchas -->
- <one line each: the trap, and what to do instead>
<!-- agent-pack:end gotchas -->

## More context
- `ARCHITECTURE.md`: modules, data flow, where to change X
- `STATUS.md`: what's live, in flight, next
- `decisions/`: why things are the way they are
