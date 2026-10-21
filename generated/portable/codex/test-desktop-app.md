Verify a claim about a running local macOS desktop app using the most background technique that can prove it, never disturbing the user.

Claim to verify: $ARGUMENTS

**Config:** `paths.projects` (default `~/Projects`) from `~/.config/operator-skills/config.yaml`, used only to find the operator-skills checkout — see `docs/config.md`. The focus policy has its own file, `~/.claude/app-testing.json`, described below.

The playbook, the harness and the measured probe results live next to this skill in the operator-skills repo:
`skills/test-desktop-app/desktop-app-testing.guide.md` and `skills/test-desktop-app/harness/`. For web apps use
`/verify-app` instead.

## Steps

1. **Locate the harness, load the playbook, check the focus mode** — Find the checkout (first match wins):

   ```bash
   PROJECTS="${PROJECTS:-$HOME/Projects}"   # use paths.projects from the config if it differs
   for d in "${DESKTOP_APP_TESTING_HOME:-}" ~/.claude/skills/operator/test-desktop-app ~/.claude/skills/test-desktop-app \
            ~/.agents/skills/test-desktop-app ~/.codex/skills/test-desktop-app \
            "$PROJECTS/operator-skills/skills/test-desktop-app" ~/operator-skills/skills/test-desktop-app; do
     [ -n "$d" ] && [ -f "$d/desktop-app-testing.guide.md" ] && { DAT_HOME="$d"; break; }
   done; echo "${DAT_HOME:-NOT FOUND}"; HARNESS="$DAT_HOME/harness"
   ```

   If it is not found, stop and tell the user where the repo should be (set `DESKTOP_APP_TESTING_HOME`). Read
   `$DAT_HOME/desktop-app-testing.guide.md` (at least sections 1, 2, 4 and 7). Run `"$HARNESS/bin/focus-mode"`.
   `background` is the safe default (config `~/.claude/app-testing.json`, `{"focus":"auto","idleMinutes":5}`; it fails
   safe and also means a locked screen or `loginwindow` in front): do not activate windows, move the cursor, or post HID
   events. `foreground` means the user is idle or away; it is re-checked before every foreground step.
2. **State the claim and pick the lowest layer that can verify it** — Ladder, most background first: 0 browser +
   `mockIPC` + unit tests (`/verify-app`), 1 in-process debug bridge, 2 window screenshot, 3 Accessibility by PID, 4
   PID-targeted keys, 5 VM, 6 foreground. Start at 0; only go down a layer when the claim cannot be proven above it.
   Measured limits: PID-posted mouse clicks do not work in the background (use AXPress or the bridge); a covered
   window's web area screenshots blank; rAF stops while the window is covered.
3. **Set up safely** — Test build with a **separate bundle identifier** ending in `.test`, `.e2e`, `.probe`, `.bridge`
   or `.refusal-check` (a `--config` overlay) and its own data dir; scratch copies of any data
   (`desktop_test.scratch_copy`); private dirs only (`mkdtemp`/0700, owner-checked, never a predictable shared `/tmp`
   path for anything executed or read as commands). Launch with
   `"$HARNESS/bin/launch-bg" <Test.app> --stderr <file> [--seed-state ...]`: it asserts the app did not become
   frontmost and records the pid. If the project has its own test bridge, use it as layer 1.
4. **Run the checks, inside the guardrails** — Only touch pids `launch-bg` recorded (`pkey`/`pclick`/`pscroll`/
   `ax press|set` and `bin/stop` refuse others). Never address the user's running app by name; no `pkill`/`killall`.
   **Never quit the app under test through the menu, AppleScript, System Events or the Dock in the background**: those
   are macOS-initiated quits and apps commonly activate themselves on them. Quit through the app's own close path
   (bridge) or `"$HARNESS/bin/stop" <pid>`; an OS quit is a foreground step or a human check. When pressing UI with
   `ax press` use `exact` ("Save" would also match "Save as copy"). Wrap foreground steps in
   `focus-guard --foreground --watch-pid <pid> -- <step>` (not run, exit 3, if the mode is `background`: record it as
   "needs idle window / human"). Wrap background steps that might disturb focus in `focus-guard --watch-pid <pid> --`:
   exit 4 means focus went to the app under test and the run is invalid. Real HID input resets the idle clock, so a
   later `auto` check will say `background`.
5. **Cap the effort** — A green build is not proof. One initial snapshot, at most ~5 live-inspection calls per
   change, at most ~3 validate-and-fix cycles. If the claim is still unproven, stop and report it rather than looping.
6. **Clean up** — `bin/stop` only the pids you started, delete the scratch dirs and the test data dir
   (`desktop_test.remove_data_dir`), and make sure no temporary hook remains in the product diff (`git diff`).
7. **Report in the required format** — Four parts: **verified live** (what you observed, which layer), **verified only
   by build/unit tests**, **not verified or skipped** (and why: user active, layer unavailable, page hidden, call
   budget), **left for a human** (native dialogs, Finder drops, real logout/shutdown, TCC prompts, a real OS quit,
   anything needing the app active). Add the focus mode used, whether `lsappinfo front` ever showed the app under test,
   and the pids you started and stopped.

## Notes
- macOS only. Needs Accessibility (AX/key events) and Screen Recording (screenshots) granted to the calling process,
  and `swiftc` (the Swift tools compile on demand into the private cache `~/Library/Caches/desktop-app-testing`).
- Facts in the playbook were measured with the `harness/fixtures/probe-app` fixture on one macOS version; re-run
  `harness/probes/run_probes.py` on a new one before relying on them. `(cd "$HARNESS" && python3 -m unittest
  tests.test_harness)` checks the harness's own safety logic without launching anything.
- Related: `/verify-app` for web apps and layer 0; `/test` for the unit-test suite; `/parallel` if several independent
  apps need checking (each with its own identifier and scratch dir).

## Worked example (one hypothetical project; replace the names with yours)
- Setup: the user's focus config is the `auto`, 5-minute one above, created at `~/.claude/app-testing.json`.
- Project: my-app (Tauri 2 + WKWebView) with a debug-only test bridge: `pnpm build:bridge` produces
  `MyApp Bridge.app` with identifier `com.example.myapp.test`; `scripts/bridge.py` drives it. Quit it with
  `Bridge.quit()`, raise its quit modal with `Bridge.request_close(from_os=True)`, never via AppleScript. See playbook
  section 8 for the protocol and the known gaps against the probe findings.
