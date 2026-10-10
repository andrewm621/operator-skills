Verify a claim about a running local macOS desktop app using the most background technique that can prove it, never disturbing the user.

Claim to verify: $ARGUMENTS

The playbook, the harness and the measured probe results live next to this skill in the operator-skills repo:
`skills/test-desktop-app/desktop-app-testing.guide.md` and `skills/test-desktop-app/harness/` (find the checkout with
`ls -d ~/Projects/operator-skills/skills/test-desktop-app`). Call the harness dir `$HARNESS`. For web apps use
`/verify-app` instead.

## Steps

1. **Load the playbook and the focus mode** — Read `desktop-app-testing.guide.md` (at least sections 1, 2, 4 and 7). Run
   `$HARNESS/bin/focus-mode`. `background` (the user is active, the default under `~/.claude/app-testing.json`
   `{"focus":"auto","idleMinutes":5}`) means: do not activate windows, move the cursor, or post HID events. `foreground`
   means the user is idle or away; it still gets re-checked before every foreground step.
2. **State the claim and pick the lowest layer that can verify it** — Ladder, most background first: 0 browser +
   `mockIPC` + unit tests (`/verify-app`), 1 in-process debug bridge, 2 window screenshot, 3 Accessibility by PID, 4
   PID-targeted keys, 5 VM, 6 foreground. Start at 0; only go down a layer when the claim cannot be proven above it.
   Layer 4 mouse clicks do not work in the background (use AXPress or the bridge); a hidden WKWebView screenshot has a
   blank web area; rAF stops while the window is covered. Details and commands are in the playbook.
3. **Set up safely** — Test build with a **separate bundle identifier** (a `--config` overlay) and its own data dir;
   scratch copies of any data (`desktop_test.scratch_copy`); private dirs only (`mkdtemp`/0700, owner-checked, never a
   predictable shared `/tmp` path for anything executed or read as commands). Launch with
   `$HARNESS/bin/launch-bg <Test.app> --stderr <file> [--seed-state ...]`, which asserts the app did not become
   frontmost. If a repo has its own test bridge (e.g. strata-v1 `scripts/bridge.py`), use it as layer 1.
4. **Run the checks, inside the guardrails** — Only touch PIDs you started. Never address the user's running app by
   name; no broad `pkill`/`killall`; validate paths before creating anything. Wrap any step that needs foreground in
   `$HARNESS/bin/focus-guard --foreground --watch-pid <pid> -- <step>`: if the mode is `background` it is not run
   (exit 3), so record it as "needs idle window / human" and move on. Wrap background steps that might disturb focus in
   `focus-guard --watch-pid <pid> --`; exit 4 means focus changed and the run is invalid.
5. **Cap the effort** — A green build is not proof. One initial snapshot, at most ~5 live-inspection calls per
   change, at most ~3 validate-and-fix cycles. If the claim is still unproven, stop and report it rather than looping.
6. **Clean up** — `kill` only the PIDs you started, delete the scratch dirs and the test data dir
   (`desktop_test.remove_data_dir`), and make sure no temporary hook remains in the product diff (`git diff`).
7. **Report in the required format** — Four parts: **verified live** (what you observed, which layer), **verified only
   by build/unit tests**, **not verified or skipped** (and why: user active, layer unavailable, page hidden, call
   budget), **left for a human** (native dialogs, Finder drops, real logout/shutdown, TCC prompts, anything needing the
   app active). Add the focus mode used, whether `lsappinfo front` ever showed the app under test, and the PIDs you
   started and stopped.

## Notes
- macOS only. Needs Accessibility (AX/key events) and Screen Recording (screenshots) granted to the calling process,
  and `swiftc` (the Swift tools compile on demand into `~/Library/Caches/desktop-app-testing`).
- Facts in the playbook were measured with the `harness/fixtures/probe-app` fixture; re-run
  `harness/probes/run_probes.py` on a new macOS version before relying on them.
- Related: `/verify-app` for web apps and layer 0; `/test` for the unit-test suite; `/parallel` if several independent
  apps need checking (each with its own identifier and scratch dir).
