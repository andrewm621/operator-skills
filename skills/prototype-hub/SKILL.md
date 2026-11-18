---
name: prototype-hub
description: >
  Turn client conversations into clickable prototype options on desktop and iPad, plus one internal review hub with live previews, a direction per track, sorted open decisions and a versioned sign-off that produces a fix list, the client's agenda and a dated record. Fable writes a sourced brief, agents build in parallel on shared made-up data, an automated gate runs after every build and fix, and a time limit is enforced. Sends nothing and publishes nothing.
argument-hint: "<client> [tracks] [--time 30m|60m|2h] [--from <notes path>]"
---

Turn what a client has said into clickable options to react to, and one hub to review them in.

Task: $ARGUMENTS

Use this when you're about to show a client what could be possible and want several real options, not one guess. For finished marketing pages use `/collateral-set`. For a guided demo of something that already exists use `/walkthrough`. For standing up a real app use `/foundation-loop`.

## The ideas that make this work

- **Options come from what was said.** The brief separates heard from assumed, with sources. Where the sources disagree, it becomes an open decision, not a silent pick.
- **One set of made-up records.** Every page reads the same shared data, so a job reads the same everywhere and the options can be compared fairly.
- **A script catches what a script can catch.** Real names on a screen, CDNs, sideways scroll and console errors are found by `check.mjs` right after each build. In the first real run, reviewers spent their most expensive rounds finding these. Reviewers now spend their time on meaning and behavior.
- **The hub is a template.** Agents only write its content, so it works the same every time.
- **The hub stays internal.** It may name people and quote them. Prototype pages may not, so they're the only part that could ever be shown to a client.
- **A review ends in decisions, not opinions.** Each track gets a direction, each open decision gets sorted, and signing off is tied to a hash of the pages. That produces what happens next: a fix list, the client's agenda and a dated record.
- **Sign-off means ready to show.** It's internal. It never means the client approved anything, and scope stays in the signed proposal. Whatever the client says about a prototype is a reaction.

## Where things live

**Config:** `paths.projects` from `~/.config/operator-skills/config.yaml` (default `~/Projects`, used only to find this repo) — see `docs/config.md`.

```bash
PROJECTS="${PROJECTS:-$HOME/Projects}"   # use paths.projects from the config if it differs
for d in "${PROTOTYPE_HUB_HOME:-}" ~/operator-skills/skills/prototype-hub "$PROJECTS/operator-skills/skills/prototype-hub" \
         ~/.claude/skills/prototype-hub ~/.claude/skills/operator/prototype-hub ~/.agents/skills/prototype-hub ~/.codex/skills/prototype-hub; do
  [ -n "$d" ] && [ -f "$d/scripts/check.mjs" ] && { PH_HOME="$(cd "$d" && pwd -P)"; break; }
done; echo "${PH_HOME:-NOT FOUND}"
```

If it's `NOT FOUND`, stop and say so. The scripts need Node 22+ and Chrome, with no install step. A run goes in the **client's** repo, at `docs/prototypes-<date>/`. Client names, rules and deny lists go in that folder's config and never in this skill.

## Steps

1. **Intake.** Read the project's `CLAUDE.md` or `AGENTS.md` first, because its rules become this run's rules. Settle these, and ask only for what you can't find.

   | Input | Where it comes from | If it's missing |
   |---|---|---|
   | Sources | Call notes, specs and emails, as absolute paths, most important first | **Stop.** No sources means nothing to base options on |
   | Tracks | What the client asked to see | Propose them from the sources, and confirm |
   | Hard rules | The project's rules, such as read-only systems or anything not agreed | Ask. Don't assume there are none |
   | Deny terms | Every real person, client, supplier and job name in the sources | Build the list by reading the sources. Add any required label to `allowPhrases` |
   | Time limit | The request | 60 minutes |
   | Devices | Who uses it where | Desktop, both iPad orientations and phone |
   | Look | The client's app or site | The template's palette |

2. **Pick the size from the time limit.** Say which you picked and what it costs.

   | Limit | Options | `criticRounds` | Agents, roughly | Basis |
   |---|---|---|---|---|
   | 30 min | 3 in all, 1 track | 1 | 13 | Estimate |
   | 60 min | 6 in all, 2 to 3 tracks | 1 | 20 to 26 | Estimate |
   | 2 hr | 9 in all, 3 tracks | 2 | 30 or more | First run: 9 options, 2 rounds, 113 min, 7.9M tokens |

3. **Set up the folder.** Write the config from `$PH_HOME/template/config.example.json` somewhere in the client's repo, then:

   ```bash
   node "$PH_HOME/scripts/new.mjs" <absolute out dir> --config <config.json>
   ```

   It refuses a folder that already has files in it.

4. **Run the workflow.** Say in one line how many agents and how long, then run it, unless the user has asked to confirm first. Load the `workflow-authoring` skill only if you need to change the script.

   ```text
   Workflow({ scriptPath: "$PH_HOME/template/workflow.js", args: { ...config, out, skillDir: PH_HOME, deadlineEpoch } })
   ```

   Get `deadlineEpoch` from `date +%s` plus the limit in seconds. Workflow scripts have no clock, so the gate's result supplies the time. Past the limit, optional critique rounds are skipped and the result names them. A stage already running isn't cut off, so the limit can still be overrun; say by how much.

5. **Check the result yourself.** The workflow's "passed" covers mechanics, not meaning.
   - Run `node "$PH_HOME/scripts/check.mjs" <out>` and read every warning. A `possibly-dead-control` may be real. A full run also writes `gate-result.js`, which is how the hub knows the gate's result and the pages version.
   - Open `index.html` and read the main screen of every page with `shot.mjs`.
   - Report `unresolved`, `skipped`, `conflicts`, any unverified tracks, and the actual time against the limit. Never round a failed gate or a skipped stage up to done.

6. **Hand over the hub.** Open it in the browser pane, or give the path. Say that it's internal, what wasn't tested (Safari and a real iPad, unless you did), and the top open decisions. Then wait. The user sets a direction per track, sorts the open decisions, clears the blockers, signs off and pastes back **Copy my review**. The fix list and agenda work without signing, so they can paste back early.

7. **Act on the review.** Save the pasted record first, as `<out>/reviews/review-<YYYY-MM-DD>.md` (add `-2` for a second one that day). It's the lasting copy, because marks in the hub live in one browser. The JSON at the end of it is what to work from.
   - **Direction, options:** brief one builder to start from `base` and take what the notes say from each `borrow` page. `none` means none of them worked: say that back and ask before rebuilding.
   - **Direction, stages:** fix `change` parts, leave `ok` parts alone, and don't build `later` parts.
   - **Keep, Combine, Drop:** these feed the direction. Leave a dropped page in place and record why. Delete nothing unless asked.
   - **Decided:** record the answer in the brief and check the pages match it.
   - **Ask:** the agenda is a draft for the user. Never send it.
   - **After any page change:** run the gate. The pages version changes, so the sign-off shows as out of date and the user signs again. Never edit a sign-off, and never tell the user it still stands.

8. **Sharing stops here.** This version doesn't publish. If asked to show the client, say the hub can't go as it is, because it names people and quotes them. Only prototype pages are candidates, and they need client-safe wording. Run the gate on exactly what would go out, and get the user's OK for that specific link and message. Draft messages; never send them. A signed-off record doesn't replace that OK.

## Guardrails

- Send nothing to anyone. Publish nothing. Commit nothing unless asked.
- The project's own rules outrank this skill, including read-only systems, production databases, and home addresses or other personal data.
- Made-up data only on prototype pages, including code comments, since anyone can view the source.
- No live AI or other metered service. Anything AI-like is canned text and labeled.
- Nothing is shown as sent, connected or agreed when it isn't.
- Never add a client's name, rules or examples to this skill. This repo is public.

## Pitfalls from the first run

- **Real names travel from sources to screens.** Builders copied a client's name onto pages in every track. The deny list has to exist before the first build, and it has to include clients and suppliers, not only people.
- **A second round doesn't mean converged.** High-severity findings only fell from 15 to 11, and one track got worse. That's why the last fix is always re-checked, and why anything left goes in the hub as a gap.
- **`overflow-x: hidden` hides the problem from a simple check.** A page can report no sideways scroll while a row of controls is cut off at the edge. `clipped-x` looks for that.
- **Forcing "three options" invents choices.** One track was really one flow in three parts. Set `shape: "stages"` and say so in the hub.
- **Client-facing wording added late means a rewrite.** Builders now return a `clientSummary` for each option so a later guided version has somewhere to start.
- **Word lists can't catch everything.** A claim about where a value comes from, or about how a process works, needs the audit against the sources.
- **Marks on single options don't say what to build.** That first review could mark an option Keep while the question it depended on stayed open. Direction and sorted decisions close that gap.
- **The hub can't see a page change by itself.** A browser can't hash files from `file://`, so a sign-off only goes out of date once the gate reruns. That's why every page change has to end with a gate run.

## Report

```text
PROTOTYPE-HUB  <client>: <passed the gate | FAILED the gate>
Hub:      <path> (internal)
Built:    <N options across M tracks> in <actual time> against a limit of <limit>
Skipped:  <what, and why, or none>
Left:     <unresolved findings, or none>
Decide:   <top open decisions, with who decides>
Not tested: <Safari, a real iPad, anything else>
Nothing was sent, published or committed.
```

## Notes

- **Files:** `scripts/check.mjs` (the gate), `scripts/shot.mjs` (screenshots), `scripts/new.mjs` (setup), `scripts/_cdp.mjs` (headless Chrome with its own temporary profile), `template/` (hub, kit, tokens, workflow, examples), `tests/` (`node --test skills/prototype-hub/tests/`).
- **Tested so far:** the gate, the hub and the whole sign-off ran against a real nine-page run in headless Chrome, and the workflow's control flow ran with stubbed agents. Timings other than the 2-hour row are estimates until they've been measured.
- `/collateral-set` shares the "cohesion comes from a file" idea, for published marketing pages. `/foundation-loop` is where the bounded-rounds rule comes from. `/walkthrough` can demo whichever option wins.
