# Desktop app testing playbook (macOS, Tauri first)

How an agent tests a local desktop app **without disturbing the person using the machine**. Tauri 2 / WKWebView is the
first target; Electron and native AppKit apps get notes where they differ and are otherwise marked "not yet verified".
Every fact in the layer sections and the results table was measured on 2026-10-10 on macOS 26 (Darwin 25.6, arm64) with
the Probe fixture in `harness/fixtures/probe-app/`; re-run `harness/probes/run_probes.py` on a new macOS or WebView
version before trusting them.

`$HARNESS` below is `skills/test-desktop-app/harness/` in the operator-skills repo. Tools are in `$HARNESS/bin/`.

Web apps are a different problem: use `/verify-app` (headless `agent-browser`). Layer 0 below reuses it.

## 1. The rule

Do not activate the app's window, move the real cursor, or send system-wide keystrokes while the user is active. Why:
on 2026-10-09 a test window popped up while Andrew was typing; a key he typed landed in the app and pressed an
autofocused Save button, which corrupted the test and wrote a file.

Focus policy lives in `~/.claude/app-testing.json`:

```json
{"focus": "auto", "idleMinutes": 5}
```

| mode | meaning |
|---|---|
| `background` | never take focus, never post HID events |
| `foreground` | anything goes (the user said the machine is free) |
| `auto` (default) | `foreground` only if no keyboard/mouse input for `idleMinutes`, else `background` |

- `$HARNESS/bin/focus-mode` prints `background` or `foreground` (idle = `HIDIdleTime` from `ioreg -c IOHIDSystem`; an
  unreadable idle time means `background`). `APP_TESTING_FOCUS=...` overrides the file for one command.
- **Re-check right before each foreground step**, not once at the start. The user can come back mid-run.
- `$HARNESS/bin/focus-guard [--foreground] [--watch-pid N] [--watch-bundle ID] [--log FILE] -- CMD ...` wraps a step:
  - default (a step that claims to be background-safe): runs it, then fails if the frontmost app changed.
  - `--foreground` (a step that needs real input or activation): re-reads `focus-mode`; if `background` the step is
    **not run** (exit 3, "not run, user active"). Report it as "needs idle window / human".
  - always records `lsappinfo front` before and after, and puts the previous app back if the app under test took the front.
  - exit codes: `0` ok, `3` foreground step skipped, `4` focus changed in background mode (restored), else the command's own status.
  - with `--watch-pid`, only a change *to the app under test* counts; the user switching apps by themselves does not.
- A step that needs foreground and cannot run is **skipped and reported**, never forced.

## 2. Guardrails (always)

1. **Only touch processes you started**, by PID or by the bundle id of your *test* build. `launch-bg` returns the PID;
   kill with `kill <pid>` only for PIDs it returned (`desktop_test.App.quit()` refuses anything else).
2. **Never address the user's running app by name** (`tell application "Strata"`, `pkill Strata`, `killall`). If the
   user's copy and your build share a name or bundle id, you cannot tell them apart. Use the test identifier.
3. **Separate test identifier and data dir.** Build the test copy with a different bundle identifier (a Tauri
   `--config` overlay, e.g. `{"identifier":"co.andrewmiller.<app>.test"}`), so its data dir
   (`~/Library/Application Support/<identifier>/`) is not the user's. `launch-bg` refuses a bundle id that does not
   contain `test`, `probe`, `e2e` or `dev`, and refuses one that is already running. `--seed-state` only writes into
   that test data dir, and only if the harness created it (marker file); `remove_data_dir()` deletes only such a dir.
4. **Scratch copies of data only.** Copy fixtures/vaults into a scratch dir (`desktop_test.scratch_copy`) and point the
   app at the copy. Never point a test at `~/knowledge`, a real vault, or the opened folder of the user's session.
5. **No broad kills.** No `pkill -f name`, no `killall`, no `osascript ... quit` aimed at a name.
6. **Validate paths before creating anything** (`assert_scratch`, `assert_private_dir`, the seed-path escape check).
7. **Scratch dirs must be private** (`mkdtemp`/0700, owner-checked); never predictable shared `/tmp` paths for anything
   executed or read as commands. That covers the built test app, the compiled Swift tools (cached in
   `~/Library/Caches/desktop-app-testing`, 0700), and any in-app command channel. Another local user must not be able
   to pre-create a dir and swap the binary or plant a command file. `private_dir()` creates such dirs;
   `launch-bg` also refuses a bundle or executable that is not owned by you or is group/world-writable.
8. **Remove temp hooks before committing.** A debug hook added to product code to drive a test (an `eval` thread, a
   log line, a forced focus call) must be reverted or sit behind the debug-only bridge. `git diff` before every commit.
9. **Background launch only**: `open -g -n`, never plain `open`/`activate`; confirm with `lsappinfo front` that the app
   did not come to the front (`launch-bg` does this and restores the previous app if it did).

## 3. Rules borrowed from Glaze (Raycast's agent loop)

- **A green build is not proof.** Build, lint and typecheck say nothing about whether the window opened, the right modal
  appeared, or focus landed where it should. Claim only what you observed in the running app.
- **Cap inspection calls.** One initial snapshot, then at most ~5 live-inspection calls per change and ~3
  validate-and-fix cycles per turn. If the claim is still unverified, stop and report it.
- **Keep an explicit "not automated, so manual check" list** and put it in the report: native open/save dialogs, Finder
  drag-drop into the window, real logout/shutdown, TCC permission prompts, anything needing the app active, anything
  that needs HID-level input while the user is active.

## 4. The layer ladder (most background first)

Pick the **lowest layer that can verify the claim**. Each entry: when, commands, needs focus, permissions, failure modes.

### Layer 0. Browser + `mockIPC` + unit tests
- **When:** UI logic, rendering, state, anything that does not need the real shell. Most claims end here.
- **How:** `/verify-app http://localhost:<port>` (headless `agent-browser`), `pnpm test`. Tauri apps: run the web
  frontend in a plain browser with `mockIPC` fake data (strata-v1: `pnpm dev`).
- **Focus:** no. **Permissions:** none. **Fails:** cannot see native chrome, real IPC, WKWebView-vs-Chromium rendering
  differences, CSP of the real webview, window lifecycle.

### Layer 1. In-process bridge (debug-only, Glaze-style)
- **When:** the real app, real IPC and real WKWebView, without focus. DOM snapshot, role/name click, `eval`, wait,
  window state.
- **Design (what to build in a debug/test build):** std-only localhost HTTP on `127.0.0.1`, a bearer token in a
  `0600` file in the app's *test* data dir, `/health`, `/eval`, `/window`; gated four ways (`cfg(debug_assertions)`, a
  non-default feature, the token, loopback), and a post-build grep proving it is absent from release binaries. A call
  budget and a refusal list (see section 3). Worked example: section 8.
- **Focus:** no. **Permissions:** none for the bridge itself.
- **Measured facts that change how you write the bridge** (probes P4, X2):
  - A window that is occluded, minimized, off-screen, or at desktop level reports `document.visibilityState ==
    "hidden"`, **`requestAnimationFrame` stops (0 fps)**, repeating timers drop to ~1/s. One-shot `setTimeout(50)`
    still fires on time (~51 ms) and `MessageChannel` round-trips in ~1 ms. Native-to-JS `evaluateJavaScript` still
    answers in 1 to 6 ms. So: **`settle()` must not wait on rAF alone**. Race it against a timer, or use
    `MessageChannel`/microtasks, otherwise every call hangs for the full timeout while the window is covered.
  - `WKWebView.takeSnapshot` renders the page **even when hidden** (1 to 7 ms, real content, in every state tested,
    including off-screen). A bridge screenshot should use it, not `screencapture` (layer 2).
  - A hidden page still receives PID-targeted keys (layer 4) and AXPress (layer 3).
  - A **"ghost" window** (normal level, `alphaValue = 0`, `ignoresMouseEvents = true`) is invisible and click-through yet
    reports `visible`, 60 to 75 fps and a live rAF **as long as no other window covers it** (checked on a free area of
    a second display; on the main display it is visible only when nothing of the user's is above it, which varies).
    Desktop-level windows (`level = desktopIconWindow + 1`) always reported occluded. Never assume: read
    `visibilityState` at test time and fall back to the timer-based settle.
- **Fails:** debug-only code can drift from release behaviour; the call budget exists for a reason.

### Layer 2. Window-scoped screenshots
- **When:** native chrome and layout as the OS draws it (title bar, menus on screen, sizing).
- **Commands:**
  ```bash
  $HARNESS/bin/dtool winlist <pid>                      # JSON: id, title, layer, x, y, w, h, onscreen, minimized
  $HARNESS/bin/capture-window pid:<pid> out.png         # or wid:<windowId>; screencapture -x -o -l<id>
  $HARNESS/bin/dtool sckshot <windowId> out.png         # ScreenCaptureKit alternative
  ```
- **Focus:** no (no activation, no cursor). **Permissions:** Screen Recording for the calling process.
- **Measured (P5):** works on an occluded and on a minimized window (both tools, same result). **Fails:** the window
  frame and native views are captured, but **a hidden WKWebView paints nothing, so the web area is blank**. Do not trust
  a screenshot of a covered window for page content; check the page region, not just "not blank" (a title bar alone
  has ~90 colors). Off-screen windows cannot be captured by either tool (`could not create image from window`,
  `SCStreamErrorDomain -3811`). A ghost window (alpha 0) captures as fully transparent. SCK from a CLI needs
  `NSApplication.shared` initialised first (else `CGS_REQUIRE_INIT` asserts); `sckshot` does this. Keep the window
  occluded, not minimized, when you can: both give a hidden page.
- **Helper pitfalls:** an app can own untitled, off-screen, layer-0 helper windows; pick the window by title/on-screen
  (`desktop_test.main_window`). `onscreen` stays true for a window whose frame is outside every display. Coordinates are
  global top-left points; `dtool displays` (or `desktop_test.displays()`) lists the displays in that space.

### Layer 3. Native chrome via Accessibility, by PID
- **When:** menus, buttons of native controls, window state (`AXMinimized`), quit paths, and (see below) buttons inside
  web content.
- **Commands:**
  ```bash
  $HARNESS/bin/dtool ax <pid> tree 10 nomenu           # dump; `nomenu` skips the huge system menu bar
  $HARNESS/bin/dtool ax <pid> press AXButton "Save"    # AXPress the first role + title/desc/value match
  $HARNESS/bin/dtool ax <pid> press AXMenuItem "Quit"  # menu items work while the app is inactive
  $HARNESS/bin/dtool ax <pid> set AXMinimized true     # window attribute on every window
  ```
  `osascript` / System Events by **unix id of your PID** also works for menus; never by app name.
- **Focus:** no. **Permissions:** Accessibility for the calling process.
- **Measured (P3):** works while the app is not frontmost, on native `NSButton`, menu items, and **buttons inside
  WKWebView**. AXPress on a web button fires trusted DOM events (`mousedown`, `mouseup`, `click`, `isTrusted: true`)
  with `document.hasFocus() == false`, and does not activate the app. **WebKit builds its web AX tree lazily:** the first
  dump shows an empty `AXGroup`; the second dump about 1 to 2 s later has `AXWebArea`, `AXTextField`, `AXButton`. No
  `AXManualAccessibility`/`AXEnhancedUserInterface` was needed; poll instead.
- **Fails:** once in ~5 full-suite runs (0 of 6 in a dedicated loop) the app element answered as its own child
  (`AXApplication` recursing) and nothing was found for 10+ s; `ax tree` now prints `!AX-DEGRADED`; relaunch. Labels
  must be unique enough to match. Tauri/Electron web content needs the same two-query wake-up.

### Layer 4. Real input posted to a PID (no HID)
- **When:** a keystroke or click must go through the real event path but the app must stay in the background.
- **Commands:**
  ```bash
  $HARNESS/bin/dtool pkey <pid> type "hello"           # unicode text, CGEventPostToPid
  $HARNESS/bin/dtool pkey <pid> key return             # a key; mods: cmd,shift,alt,ctrl (e.g. `key e cmd`)
  $HARNESS/bin/dtool pclick <pid> <x> <y> <windowId>   # global screen points; see result below
  $HARNESS/bin/dtool pscroll <pid> <x> <y> <dy>
  ```
- **Focus:** no (never activates, the cursor does not move). **Permissions:** Accessibility for the caller.
- **Keys work (P1):** `keydown`/`input`/`keyup` arrive in a backgrounded WKWebView field, `isTrusted: true`, even when
  the window is hidden/occluded, with `document.hasFocus() == false` and no activation.
- **Mouse does NOT work (P2):** with `acceptsFirstMouse` false **and** true, occluded and not occluded, nothing acts.
  Posted to the PID, the click reaches AppKit with `windowNumber 0` and is dropped. Stamping the window id in the
  undocumented CGEvent field 51 (`pclick` does) makes the `mouseDown` reach the window, but no `mouseUp` is seen and
  neither the web element nor a native `NSButton` reacts; the app is never activated. So the Tauri/wry
  `accept_first_mouse(true)` lever does **not** rescue PID-posted clicks (it is only relevant to real HID clicks, not
  tested because they activate). Not tried: SkyLight `SLEventPostToPid` / `cua-driver` (private, fragile; Cua reports it
  refuses on WKWebView), session-tap posting (would hit whatever window is topmost under the point, the user's).
  **Click via layer 3 (AXPress) or layer 1 (bridge) instead.**
- **Real HID clicks** (`dtool hidclick`, `desktop_test.hid_click`) move the user's cursor and activate: foreground mode
  only, and only inside `focus-guard --foreground`.

### Layer 5. VM (Tart/Lume macOS guest)
- **When:** you need true foreground behaviour, activation, TCC prompts, or a clean machine, and a human is not
  available. **Focus:** fully isolated. **Permissions:** none on the host.
- **Cost:** ~25 GB image, at most 2 macOS VMs, slow. **Not run in this pass.**

### Layer 6. Foreground (user idle or away)
- **When:** the claim needs real HID input, activation, Mission Control/Spaces, or window focus behaviour, and
  `focus-mode` says `foreground`.
- **How:** wrap every step: `focus-guard --foreground --watch-pid <pid> -- <step>`; re-check right before each.
- **Not run here (user active):** plain `open` (activates), bare-executable `Popen` launch (earlier strata-v1 runs
  launched this way and the window came to the front), `hidclick`, Space switching, a visible frontmost baseline.

## 5. Launching and cleaning up

```bash
# .app bundle: open -g -n --stderr FILE, PID found by diffing processes under App.app/Contents/MacOS
$HARNESS/bin/launch-bg /path/to/Test.app --stderr "$SCRATCH/app.log" \
    --seed-state '{"last_folder":"/scratch/vault-copy"}:state.json' -- <app args>
# -> {"pid":..,"bundle_id":..,"window":{..},"stderr":"..","front_before":{..}}
kill <pid>            # only PIDs launch-bg returned
```

- Exit 4 means the app became frontmost during launch; the previous app was restored and the run is invalid.
- A bare executable (`target/debug/<app>`) launches via `Popen` without LaunchServices, no `--seed-state`; prefer the
  `.app` bundle with the test identifier.
- **P6:** `open -g -n` never made the app frontmost in 3 of 3 cold launches (25 ms sampling for ~5 s); the window
  appeared after ~2.4 to 3.1 s. Wait for the window, do not sleep a fixed time.
- Background-launched regular apps show up in the Dock and Cmd-Tab. In one earlier, discarded run a probe pid appeared
  frontmost 11 s after launch while the user was switching apps rapidly (the probe never calls activate; this looks like
  the user landing on it). Test builds that can run as accessory apps (no Dock/Cmd-Tab entry) are safer; **untested here**.
- From Python: `import desktop_test as dt` (`$HARNESS/lib`): `launch_bg`, `windows`, `main_window`, `capture`, `key`,
  `type_text`, `click`, `ax_tree`, `ax_press`, `focus_mode`, `front_app`, `scratch_copy`, `private_dir`.
  Swift tools compile on first use into `~/Library/Caches/desktop-app-testing`.

## 6. Probe results (P1 to P6, plus what they turned up)

Probe app: `harness/fixtures/probe-app/Probe.swift`, Swift AppKit + WKWebView, bundle id `co.andrewmiller.desktop-probe`,
`acceptsFirstMouse` switchable. Built into a private temp dir; never strata-v1. Raw data: `harness/probes/last-run/`.

| # | Question | Result | Notes |
|---|---|---|---|
| P1 | PID-targeted key into a backgrounded WKWebView field | **works** | keydown/input/keyup `isTrusted:true`; typed `hellox` into the field; `hasFocus()` false; no activation; also when hidden |
| P2 | PID-targeted click, `acceptsFirstMouse` false then true | **doesn't work** (both) | occluded and not occluded; click arrives with windowNumber 0 and is dropped; with private field 51 the mouseDown reaches the window but nothing acts and no mouseUp is seen; never activates |
| P3 | WKWebView AX tree dump + AXPress while not frontmost | **works** | web tree appears on the 2nd dump; AXPress on web button fires trusted mousedown/up/click; native button and menu item also work; app never activated; one observed degraded-AX flake |
| P4 | `visibilityState` + rAF when occluded / off-screen / other Space | **hidden, rAF 0 fps** | occluded by sibling window, level-back, off-screen (x=-6000), minimized: all `hidden`, rAF 0, timers ~1 to 2/s; native `evaluateJavaScript` 1 to 6 ms; rAF-based wait times out. Ghost window uncovered: `visible`, 60 to 75 fps. **Other Space: not run, user active** |
| P5 | `screencapture -l` vs ScreenCaptureKit on an occluded window | **both capture the window, web area blank** | identical for occluded and minimized; off-screen fails in both; ghost (alpha 0) captures transparent; in-process `takeSnapshot` works hidden (1 to 7 ms) |
| P6 | `open -g -n` cold launch vs `lsappinfo front` | **doesn't steal focus** | 0 of 3 launches frontmost; window after 2.4 to 3.1 s. Plain `open` and bare-exe launch: **not run, user active** |
| X1 | Ghost window keeps a page live without being seen | works when uncovered | see layer 1 |
| X2 | `WKWebView.takeSnapshot` while hidden | works | see layer 1 |
| X3 | SCK from a CLI | works after `NSApplication.shared` | see layer 2 |

Focus rules applied during the run: `focus-mode` was `background` throughout (user active); PID-targeted events,
`screencapture -l`, AX by PID, `open -g` only. Nothing was activated, no HID events were posted. A watcher sampled
`lsappinfo front` every 50 ms for the whole run: **the probe was never frontmost (0 times)**; the 13 front changes
were the user's own app switches. `lsappinfo front` before/after each step (other apps anonymised, pid shown):

```
    0.0s P1             start                                      front=other-app(64511) idle=1.5s
    2.4s P1             before keys                                front=other-app(64511) idle=4.0s
    4.1s P1             after keys                                 front=other-app(64511) idle=1.3s
    4.9s P2             start                                      front=other-app(64511) idle=2.1s
    7.5s P2-afm0-back   before clicks                              front=other-app(64511) idle=4.7s
   11.2s P2-afm0-back   after clicks                               front=other-app(64511) idle=0.4s
   14.8s P2-afm1-back   before clicks                              front=other-app(64511) idle=0.2s
   18.5s P2-afm1-back   after clicks                               front=other-app(89068) idle=0.2s   (user switched)
   21.7s P2-afm0-free   before clicks                              front=other-app(89068) idle=0.2s
   25.4s P2-afm0-free   after clicks                               front=other-app(89068) idle=0.3s
   29.3s P2-afm1-free   before clicks                              front=other-app(89068) idle=0.2s
   33.0s P2-afm1-free   after clicks                               front=other-app(89068) idle=0.0s
   36.8s P3             before ax                                  front=other-app(89068) idle=0.7s
   41.1s P3             after ax                                   front=other-app(89068) idle=0.0s
   44.5s P4             V launched (second display, level back)    front=other-app(89068) idle=0.3s
   59.6s P4             G launched (ghost: alpha 0, ignore-mouse)  front=other-app(89068) idle=0.4s
   75.3s P4             G2 launched (ghost, main display)          front=other-app(89068) idle=3.3s
   90.6s P4             A launched                                 front=other-app(89068) idle=0.2s
  105.8s P4             B (occluder) launched                      front=other-app(64511) idle=0.3s   (user switched)
  120.4s P4             C launched (off-screen)                    front=other-app(89068) idle=0.1s
  134.5s P4             D launched                                 front=other-app(9231)  idle=0.1s   (user switched)
  135.8s P4             D minimized                                front=other-app(9231)  idle=0.1s
  148.1s P4             D done                                     front=other-app(9231)  idle=0.0s
  149.0s P6-0           before open -g -n                          front=other-app(9231)  idle=0.3s
  154.1s P6-0           after launch + 2.5s                        front=other-app(9231)  idle=0.3s
  154.8s P6-1           before open -g -n                          front=other-app(9231)  idle=0.1s
  159.8s P6-1           after launch + 2.5s                        front=other-app(9231)  idle=1.4s
  160.6s P6-2           before open -g -n                          front=other-app(9231)  idle=2.2s
  165.8s P6-2           after launch + 2.5s                        front=other-app(9231)  idle=0.4s
```

Run-to-run variance seen across the (several) runs made while building this: the ghost window on the main display was
`visible` in some runs and `hidden` in others (it depends on what of the user's windows are above it at that moment);
the degraded-AX flake appeared once. Both are why the guide says to read state at test time instead of assuming.

## 7. Reporting format

Every desktop-test report has these four parts. A green build is not a verified claim.

1. **Verified live** (what you actually observed, with the layer): e.g. "dirty buffer + OS quit raises the modal and
   `document.activeElement` is Cancel (layer 1, `/eval`); Return did not save (file hash unchanged)".
2. **Verified only by build/unit tests** (say so).
3. **Not verified / skipped** and why: "needs idle window / human", "layer unavailable", "page was hidden so screenshot
   web area is blank", "call budget reached".
4. **Left for a human** (the manual list): native dialogs, Finder drops, real logout/shutdown, TCC prompts, Dock
   interaction, anything requiring the app active while the user is active.

Also state the focus mode used, whether `lsappinfo front` ever showed the app under test, the PID(s) you started and
that you stopped them, the scratch/data dirs used and removed, and that no temp hooks remain in the diff.

## 8. Worked example: strata-v1 (Tauri 2 + WKWebView markdown viewer/editor)

> The debug-only `test-bridge` was being built on branch `phase-9-test-bridge` in the strata-v1 repo when this was
> written. **See the strata-v1 repo once merged** for the real flags, endpoints and `scripts/bridge.py`. This section
> is the design, not a verified description.

**Lessons that motivated all of this** (strata-v1 `docs/PROGRESS.md`, 5.5, P7, P8): tests were driven by a Swift
`CGEvent` click/key tool, `screencapture -l`, `osascript`, and a temporary uncommitted `lib.rs` hook that `eval`ed JS.
The OS quit request activates the app, so the user's own keystroke landed on the modal's autofocused Save button and
saved a file; fixed in 1.1.1 by focusing Cancel for OS-originated quits. The harness here replaces the click tool
(layer 4 mouse does not work) and the temp hook (layer 1).

**Test build and identity.** Build a debug bundle with an identifier overlay so it never shares state with the user's
Strata (the user's app uses `co.andrewmiller.strata`; the test one uses `co.andrewmiller.strata.test`, data dir
`~/Library/Application Support/co.andrewmiller.strata.test/`). Exact build flags: see the strata-v1 repo. Seed the remembered
folder with a scratch copy of `fixtures/vault/`:

```bash
SCRATCH=$(python3 -c 'import sys; sys.path.insert(0,"'$HARNESS'/lib"); import desktop_test as d; print(d.private_dir())')
cp -R fixtures/vault "$SCRATCH/vault"
$HARNESS/bin/launch-bg path/to/Strata.test.app --stderr "$SCRATCH/app.log" \
    --seed-state "{\"last_folder\":\"$SCRATCH/vault\"}:state.json"
```

**The bridge (layer 1), as designed.** std-only localhost HTTP server compiled only into debug test builds
(`cfg(debug_assertions)` plus a non-default feature), bound to `127.0.0.1`, bearer token written to
`app_data_dir/test-bridge.json` (mode 0600, in the test identifier's data dir). Endpoints: `/health` (is it up, app
version, window labels), `/eval` (run JS in the main webview, returns the JSON result), `/window` (window state and
window-scoped actions). Client: `scripts/bridge.py` in the strata-v1 repo reads the discovery file and calls these.
Apply the measured facts above: use `takeSnapshot` for screenshots; make the `settle()` after an action rAF-plus-timer;
check `visibilityState`; set a call budget; refuse file-drop and native-dialog requests up front and list them as manual.

**Typical session** (claim: "Cmd+E toggles source mode and the dirty guard works"):
1. Layer 0: `pnpm test`, `/verify-app` on `pnpm dev`. Cheap, do first.
2. `launch-bg` the test bundle; wait for `/health`.
3. Layer 1: `/eval` to click the note in the tree, dispatch the keydown, read `document.activeElement` and the
   CodeMirror doc; assert the file on disk is unchanged (`sha`), no `.strata-tmp-*` exists.
4. Layer 3: quit through the menu by PID (`dtool ax <pid> press AXMenuItem "Quit Strata"`), confirm the modal via
   `/eval`; Cancel through `/eval` or AXPress. For the OS-quit path use `osascript` with **the test bundle id only**
   (`tell application id "co.andrewmiller.strata.test" to quit`), never the app name.
5. Layer 2 only if native chrome matters (and remember the web area is blank while hidden; use `takeSnapshot`).
6. `kill <pid>`; delete the scratch dir and the test data dir (`remove_data_dir`).

**Report as manual:** the native folder-picker dialog (Change folder), Finder drops, real logout/shutdown (the
`applicationShouldTerminate:` path for those is only verified via AppleScript quit), any TCC prompt, and a real HID
click or Cmd+Q keypress when the user is active.

## 9. Harness reference

| Tool | What | Needs |
|---|---|---|
| `bin/focus-mode [-v]` | prints `background` / `foreground` | nothing |
| `bin/focus-guard` | run a step, record/restore frontmost app, fail on focus change | nothing |
| `bin/launch-bg` | `open -g -n` (or `Popen`), returns PID, asserts not frontmost, test-id and ownership checks | nothing |
| `bin/capture-window` | `pid:N` / `wid:N` to PNG via `screencapture -x -o -l` | Screen Recording |
| `bin/dtool winlist\|pkey\|pclick\|pscroll\|ax\|sckshot\|hidclick\|displays` | on-demand Swift tools | Accessibility (pkey/pclick/pscroll/ax), Screen Recording (sckshot) |
| `lib/desktop_test.py` | stdlib Python API tying them together | |
| `fixtures/probe-app/` | `Probe.swift` + `build.sh` (private out dir) | `swiftc` |
| `probes/run_probes.py` | re-runs P1 to P6, writes results.json and focus.log into a fresh private dir | Accessibility, Screen Recording |

Permissions are granted to the *calling process* (Terminal or the agent host), not to the tools. If a probe returns a
blank or "could not create image", check Screen Recording; if `ax`/`pkey` exit 3, check Accessibility.
`DESKTOP_TEST_CACHE`, `DESKTOP_TEST_SCRATCH` (extra scratch roots), `APP_TESTING_CONFIG`, `APP_TESTING_FOCUS` override defaults.
