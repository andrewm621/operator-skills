# Desktop app testing playbook (macOS, Tauri first)

How an agent tests a local desktop app **without disturbing the person using the machine**. Tauri 2 / WKWebView is the
first target; Electron and native AppKit apps get notes where they differ and are otherwise marked "not yet verified".
Every fact in the layer sections and the results table was measured on 2026-10-10 on macOS 26 (Darwin 25.6, arm64) with
the Probe fixture in `harness/fixtures/probe-app/`; re-run `harness/probes/run_probes.py` on a new macOS or WebView
version before trusting them.

`$HARNESS` below is `skills/test-desktop-app/harness/` in the operator-skills repo. Tools are in `$HARNESS/bin/`.

Web apps are a different problem: use `/verify-app` (an `agent-browser` flow; the repo source of that skill and a
locally installed copy can differ on whether it uses a headless browser or an attached one, so check which you have).
Layer 0 below reuses it.

## 1. The rule

Do not activate the app's window, move the real cursor, or send system-wide keystrokes while the user is active. Why:
in an earlier real run (a Tauri app, 2026-10-09) a test window popped up while the user was typing; a key they typed
landed in the app and pressed an autofocused Save button, which corrupted the test and wrote a file.

Focus policy lives in `~/.claude/app-testing.json`:

```json
{"focus": "auto", "idleMinutes": 5}
```

| mode | meaning |
|---|---|
| `background` | never take focus, never post HID events |
| `foreground` | anything goes (the user said the machine is free) |
| `auto` (default) | `foreground` only if no keyboard/mouse input for `idleMinutes`, else `background` |

`focus_mode()` **fails safe**. Only the exact lowercase strings above mean anything; a typo, wrong case, a non-string,
a bad `idleMinutes` (string, negative, NaN, bool), a config file that is not a JSON object, an unreadable idle time, or
any exception at all returns `background`. A **locked screen, no GUI session, or `loginwindow` as the frontmost app is
`background` in every mode** (an idle machine at the lock screen has nobody to ask, and nothing to type into). The unit
tests in `harness/tests/` cover each case.

- `$HARNESS/bin/focus-mode` prints `background` or `foreground` (idle = `HIDIdleTime` from `ioreg -c IOHIDSystem`).
  `APP_TESTING_FOCUS=...` (non-empty) overrides the file for one command.
- **Re-check right before each foreground step**, not once at the start. The user can come back mid-run.
- **The harness's own HID input resets the idle clock.** After a foreground step that posts real input (`hidclick`),
  the next `auto` check says `background` until the user has again been idle for `idleMinutes`. Do not plan a long
  sequence of foreground steps on `auto`; batch them into one `focus-guard --foreground` call or ask for `foreground`.
- `$HARNESS/bin/focus-guard [--foreground] [--watch-pid N] [--watch-bundle ID] [--log FILE] -- CMD ...` wraps a step:
  - default (a step that claims to be background-safe): runs it while sampling `lsappinfo front` about every 50 ms, so a
    transient steal inside the step is caught, not only the state before/after.
  - `--foreground` (a step that needs real input or activation): re-reads `focus-mode`; if `background` the step is
    **not run** (exit 3, "not run, user active"). Report it as "needs idle window / human".
  - always records `lsappinfo front` before, during and after.
  - **with a watch list** (`--watch-pid` / `--watch-bundle`, which you should always pass): only the front app becoming
    a *watched* app is a violation (exit 4); the previous app is restored only if a watched app is *still* in front
    afterwards; the user switching to some other app is reported (`focus_changed`) but neither a violation nor restored.
  - **without a watch list** the guard cannot tell a steal from the user switching apps: it reports `focus_changed` with
    `attributed: null`, restores nothing, and (background mode) exits 5.
  - exit codes: `0` ok, `3` foreground step skipped, `4` focus went to a watched app in background mode (restored), `5`
    focus changed with no watch list (unattributed, not restored). A command's own exit status passes through, except
    that its 3, 4 or 5 is reported as 103, 104 or 105 so it cannot be mistaken for the guard's. The JSON summary line on
    stderr is authoritative (`cmd_rc` is the command's real status).
- A step that needs foreground and cannot run is **skipped and reported**, never forced.

## 2. Guardrails (always)

1. **Only touch processes you started**, by PID or by the bundle id of your *test* build. `launch-bg` returns the PID
   and records `{pid, bundle id, start time, executable}` in the private cache. `pkey`, `pclick`, `pscroll`,
   `ax press|set|enable` and `bin/stop <pid>` refuse any pid without a matching record (so a reused pid, or the
   user's own app, is refused). Stop with `bin/stop <pid>`; `desktop_test.App.quit()` is the in-process equivalent.
2. **Never address the user's running app by name** (`tell application "MyApp"`, `pkill MyApp`, `killall`). If the
   user's copy and your build share a name or bundle id, you cannot tell them apart. Use the test identifier.
3. **Separate test identifier and data dir.** Build the test copy with a different bundle identifier (a Tauri
   `--config` overlay, e.g. `{"identifier":"co.example.<app>.test"}`), so its data dir
   (`~/Library/Application Support/<identifier>/`) is not the user's. `launch-bg` refuses a bundle id that does not
   END in `.test`, `.e2e`, `.probe`, `.bridge` or `.refusal-check` (`-probe`-style suffixes also pass; `dev.zed.Zed` and
   `com.test.realapp` do not), and refuses one that is already running. `--seed-state` only writes into
   that test data dir, and only if the harness created it (marker file); `remove_data_dir()` deletes only such a dir.
4. **Scratch copies of data only.** Copy fixtures/vaults into a scratch dir (`desktop_test.scratch_copy`) and point the
   app at the copy. Never point a test at `~/knowledge`, a real vault, or the opened folder of the user's session.
5. **No broad kills, and no OS-level quit of an app you are testing in the background.** No `pkill -f name`, no
   `killall`. Menu "Quit", `osascript ... to quit`, Dock Quit and logout are *macOS-initiated quits*, and apps often
   activate themselves on them (my-app does so on purpose, and its docs say not to quit that way). Quit a test app
   through its own bridge/close event or by its recorded pid (`bin/stop`). A real OS quit is tested only inside
   `focus-guard --foreground`, or left for a human.
6. **Validate paths before creating anything** (`assert_scratch`, `assert_private_dir`, the seed-path escape check).
7. **Scratch dirs must be private** (`mkdtemp`/0700, owner-checked); never predictable shared `/tmp` paths for anything
   executed or read as commands. That covers the built test app, the compiled Swift tools (cached in
   `~/Library/Caches/desktop-app-testing`, 0700), and any in-app command channel. Another local user must not be able
   to pre-create a dir and swap the binary or plant a command file. `private_dir()` creates such dirs.
   `launch-bg` also runs `assert_owned_executable`. What it checks: every parent directory (owned by you or root, not
   world-writable unless sticky, not group-writable unless root-owned); the bundle, `Contents`, `Contents/MacOS`, every
   entry in `MacOS`, `Contents/Frameworks` and its top-level entries (owned by you or root, not group/world-writable);
   symlinks there are followed and their real target is checked the same way. What it does not check: files deeper
   inside `Frameworks`/`Resources`, and code signing.
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
- **How:** `/verify-app http://localhost:<port>`, then the project's unit tests. Tauri apps: run the web frontend in a
  plain browser with `mockIPC` fake data (section 8's example project does this with `pnpm dev`).
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
    "hidden"`, **`requestAnimationFrame` stops (0 fps)**, and a repeating 100 ms `setInterval` drops to ~1 to 2 ticks/s.
    A single one-shot `setTimeout(50)` still fired on time (~50 to 52 ms) and a `MessageChannel` round-trip took 0 to
    1 ms. The probe's native-to-JS call (`callAsyncJavaScript`) answered `1 + 1` in 0 to 92 ms (median 4 ms over
    the 7 states measured; the 92 ms case was the off-screen window). So: **`settle()` must not wait on rAF alone**. Race it against a timer, or
    use `MessageChannel`/microtasks, otherwise every call hangs for its full timeout while the window is covered.
  - **Hidden is about being covered/minimized/off-screen, not about being unfocused.** An inactive but uncovered window
    ran at 60 to 75 fps. (The my-app bridge measured un-throttled timers and rAF with its window in the background,
    which fits: that window was visible. Expect the stalls the moment another window covers it.)
  - **Chained sleeps** (a loop of `await sleep(50)`) were NOT measured in the committed run; the probe now has a
    10 x 50 ms chained-timer check (`eval_chained`) that has not been run yet. Treat sequences of sleeps as possibly
    ~1 s per step while hidden until it has.
  - `WKWebView.takeSnapshot` returned real page content (1 to 7 ms; 23 ms once) in every state tested, including
    hidden and off-screen, **but only for a static page**. Whether a page that changes while hidden is reflected in the
    snapshot is not yet shown: the probe now has that check (`reflects_dom_change_while_hidden`), not yet run. A bridge
    screenshot should still prefer it over `screencapture` (layer 2), but verify a changing page before trusting it.
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
  frame and native views are captured, but in these runs **the web area was blank** while the page was hidden (a
  1-color region where the page draws its heading/input/button). The natural reading is that a hidden WKWebView does not
  paint. Caveat: the committed run has no *visible* control capture (a window that is visible must show the content);
  one ad-hoc control (alpha 0.3 window on a free spot) did show it, and the probe now includes that control
  (`Vc visible control`), not yet re-run. Do not trust a screenshot of a covered window for page content; check the
  page region, not just "not blank" (a title bar alone has ~90 colors). Off-screen windows cannot be captured by either tool (`could not create image from window`,
  `SCStreamErrorDomain -3811`). A ghost window (alpha 0) captures as fully transparent. SCK from a CLI needs
  `NSApplication.shared` initialised first (else `CGS_REQUIRE_INIT` asserts); `sckshot` does this. Keep the window
  occluded, not minimized, when you can: both give a hidden page.
- **Helper pitfalls:** an app can own untitled, off-screen, layer-0 helper windows; pick the window by title/on-screen
  (`desktop_test.main_window`). `onscreen` stays true for a window whose frame is outside every display. Coordinates are
  global top-left points; `dtool displays` (or `desktop_test.displays()`) lists the displays in that space.

### Layer 3. Native chrome via Accessibility, by PID
- **When:** menus, buttons of native controls, window state (`AXMinimized`), and (see below) buttons inside web content.
  Not for quitting (see the warning in the commands).
- **Commands:**
  ```bash
  $HARNESS/bin/dtool ax <pid> tree 10 nomenu           # dump; `nomenu` skips the huge system menu bar
  $HARNESS/bin/dtool ax <pid> press AXButton "Save" exact          # AXPress; `exact` = whole label must match
  $HARNESS/bin/dtool ax <pid> press AXMenuItem "Open Recent" exact # menu items work while the app is inactive
  $HARNESS/bin/dtool ax <pid> set AXMinimized true                 # the only settable attribute; on every window
  ```
  Always use `exact` unless you mean "contains": without it "Save" also matches "Save as copy" and "Quit" also matches
  "Force Quit...". (`desktop_test.ax_press` defaults to exact.) The tool refuses other attributes (`AXFrontmost` would
  activate the app) and only `enable` accepts `AXManualAccessibility`/`AXEnhancedUserInterface`. Input commands accept
  only pids that `launch-bg` recorded.
  **Do not use this layer to quit the app** (menu "Quit", `osascript ... to quit`, System Events, Dock). That is a
  macOS-initiated quit, which many apps handle by activating themselves (my-app does, deliberately). Use the app's
  own close path via layer 1, or `bin/stop <pid>`; an OS quit is a `focus-guard --foreground` step or a human check.
  `osascript`/System Events by **unix id of your recorded PID** is fine for *reading* menu state, never by app name.
- **Focus:** no. **Permissions:** Accessibility for the calling process.
- **Measured (P3):** works while the app is not frontmost, on native `NSButton`, menu items, and **buttons inside
  WKWebView**. AXPress on a web button fires trusted DOM events (`mousedown`, `mouseup`, `click`, `isTrusted: true`)
  with `document.hasFocus() == false`, and does not activate the app. **WebKit builds its web AX tree lazily:** the first
  dump shows an empty `AXGroup`; the second dump about 1 to 2 s later has `AXWebArea`, `AXTextField`, `AXButton`. No
  `AXManualAccessibility`/`AXEnhancedUserInterface` was needed; poll instead.
- **Fails:** once in ~5 full-suite runs (0 of 6 in a dedicated loop) the app element answered as its own child
  (`AXApplication` recursing) and nothing was found for 10+ s; `ax tree` now prints `!AX-DEGRADED`; relaunch. Labels
  must be unique enough to match. Only a WKWebView inside a plain AppKit app was measured; a Tauri app uses the same
  WebKit view so the two-query wake-up is likely to apply, Electron (Chromium) was not tested.

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
- **Not run here (user active):** plain `open` (activates), bare-executable `Popen` launch (earlier runs of a Tauri app
  launched this way and the window came to the front), `hidclick`, Space switching, a visible frontmost baseline.

## 5. Launching and cleaning up

```bash
# .app bundle: open -g -n --stderr FILE, PID found by diffing processes under App.app/Contents/MacOS
$HARNESS/bin/launch-bg /path/to/Test.app --stderr "$SCRATCH/app.log" \
    --seed-state '{"last_folder":"/scratch/vault-copy"}:state.json' -- <app args>
# -> {"pid":..,"bundle_id":..,"window":{..},"stderr":"..","front_before":{..}}
$HARNESS/bin/stop <pid>     # refuses any pid launch-bg did not record (start time + bundle id must still match)
```

- Exit 4 means the app became frontmost during launch; the previous app was restored and the run is invalid.
- A bare executable (`target/debug/<app>`) launches via `Popen` without LaunchServices, no `--seed-state`; prefer the
  `.app` bundle with the test identifier.
- **P6:** `open -g -n` never made the app frontmost in 3 of 3 cold launches in the committed run (and 0 of 3 in each
  earlier run). `lsappinfo front` was sampled continuously for ~5 s per launch; each sample costs two `lsappinfo`
  calls, so the real spacing was ~45 to 55 ms (90 to 115 samples), not 25 ms. `launch_bg` returned after ~2.4 s, but
  **about 2.0 s of that is the harness's own front-watch loop**, so the probe's real time-to-window is well under that;
  do not read 2.4 s as the app's boot time. Wait for the window, do not sleep a fixed time.
- Background-launched regular apps show up in the Dock and Cmd-Tab. In one earlier, discarded run a probe pid appeared
  frontmost 11 s after launch while the user was switching apps rapidly (the probe never calls activate; this looks like
  the user landing on it). Test builds that can run as accessory apps (no Dock/Cmd-Tab entry) are safer; **untested here**.
- From Python (`PYTHONPATH="$HARNESS/lib" python3 ...`): `import desktop_test as dt`: `launch_bg`, `windows`, `main_window`, `capture`, `key`,
  `type_text`, `click`, `ax_tree`, `ax_press`, `focus_mode`, `front_app`, `scratch_copy`, `private_dir`.
  Swift tools compile on first use into `~/Library/Caches/desktop-app-testing`.

## 6. Probe results (P1 to P6, plus what they turned up)

Probe app: `harness/fixtures/probe-app/Probe.swift`, Swift AppKit + WKWebView, bundle id `com.example.desktop-probe`,
`acceptsFirstMouse` switchable. Built into a private temp dir; never a real app. Raw data: `harness/probes/last-run/`.

| # | Question | Result | Notes |
|---|---|---|---|
| P1 | PID-targeted key into a backgrounded WKWebView field | **works** | keydown/input/keyup `isTrusted:true`; typed `hellox` into the field; `hasFocus()` false; no activation; also when hidden |
| P2 | PID-targeted click, `acceptsFirstMouse` false then true | **doesn't work** (both) | occluded and not occluded; click arrives with windowNumber 0 and is dropped; with private field 51 the mouseDown reaches the window but nothing acts and no mouseUp is seen; never activates |
| P3 | WKWebView AX tree dump + AXPress while not frontmost | **works** | web tree appears on the 2nd dump; AXPress on web button fires trusted mousedown/up/click; native button and menu item also work; app never activated; one observed degraded-AX flake |
| P4 | `visibilityState` + rAF when occluded / off-screen / other Space | **hidden, rAF 0 fps** | occluded by sibling window, level-back, off-screen (x=-6000), minimized: all `hidden`, rAF 0, timers ~1 to 2/s; native-to-JS `callAsyncJavaScript` 0 to 92 ms (median 4); rAF-based wait times out; chained sleeps not yet measured. Ghost window uncovered: `visible`, 60 to 75 fps. **Other Space: not run, user active** |
| P5 | `screencapture -l` vs ScreenCaptureKit on an occluded window | **both capture the window, web area blank** | identical for occluded and minimized; off-screen fails in both; ghost (alpha 0) captures transparent; in-process `takeSnapshot` works hidden (1 to 7 ms; static page only). Caveat: no visible control capture in this run |
| P6 | `open -g -n` cold launch vs `lsappinfo front` | **doesn't steal focus** | 0 of 3 launches frontmost; ~45 to 55 ms sampling for ~5 s; `launch_bg` returned at ~2.4 s, ~2.0 s of which is its own watch loop. Plain `open` and bare-exe launch: **not run, user active** |
| X1 | Ghost window keeps a page live without being seen | works when uncovered | see layer 1 |
| X2 | `WKWebView.takeSnapshot` while hidden | works for a static page | changing page: probe added, not yet run |
| X3 | SCK from a CLI | works after `NSApplication.shared` | see layer 2 |

Focus rules applied during the run: `focus-mode` was `background` throughout (user active); PID-targeted events,
`screencapture -l`, AX by PID, `open -g` only. Nothing was activated, no HID events were posted. A watcher sampled
`lsappinfo front` every 50 ms for the whole run: **the probe was never frontmost (0 times)**; the watcher logged 12 front
changes after its first sample (13 entries), all the user's own app switches. `lsappinfo front` before/after each step (other apps anonymised, pid shown):

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

**Added after review, not yet run** (the focus rules at that moment did not allow launching GUI apps, and
`harness/probes/last-run/` predates them): chained 10 x 50 ms timers while hidden (`eval_chained`), a snapshot after a
DOM change while hidden (`reflects_dom_change_while_hidden`), and a visible control capture (`Vc`). Run
`python3 harness/probes/run_probes.py` when the machine is yours to use and update this table.

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

## 8. Worked example: my-app (Tauri 2 + WKWebView markdown viewer/editor)

> **Worked example for one hypothetical project (`my-app`); swap in your own names.** Everything in sections 1 to 7 and 9 is generic; this
> section shows the ladder applied to a Tauri app whose debug-only test
> bridge is merged. The source of truth would be that repo's `AGENTS.md` ("Test bridge (debug
> only)"), `scripts/bridge.py` and `src-tauri/src/test_bridge.rs`; read them before relying on this summary.

**Why it exists.** Earlier tests there used a Swift `CGEvent` click/key tool, `screencapture -l`, `osascript`, and a
temporary uncommitted `lib.rs` hook that `eval`ed JS. The OS quit request activates the app (on purpose: `quit_macos.rs`),
so a key the user was typing landed on the modal's autofocused Save button and saved a file; fixed by focusing Cancel
for OS-originated quits. The harness here replaces the click tool (PID-posted mouse clicks do not work, layer 4) and
the temp hook (layer 1).

**Build and identity.** `pnpm build:bridge` runs `tauri build --debug --bundles app --features test-bridge --config
src-tauri/tauri.bridge.conf.json`. The overlay sets the identifier to `com.example.myapp.test` and the product
name to `MyApp Bridge`; the bundle is `src-tauri/target/debug/bundle/macos/MyApp Bridge.app`, and its data dir is
`~/Library/Application Support/com.example.myapp.test/`, never the real app's. The bridge compiles only under
`cfg(all(debug_assertions, feature = "test-bridge"))` (`compile_error!` otherwise), **refuses to start unless the
app's identifier is exactly `com.example.myapp.test`** (so a bridge feature on the real identifier serves
nothing), and `scripts/assert-no-bridge.sh <binary|.app>` greps for its sentinel strings and must pass on every
release build. One bridge instance per data dir at a time.

**Protocol (as built).** A hand-rolled HTTP/1.1 server (`std::net`, no dependency) on `127.0.0.1:0`; at startup it writes
`{port, token, pid}` to `<data dir>/test-bridge.json` (0600). Every request needs `Authorization: Bearer <token>` and a
loopback `Host`.
- `GET /health` -> `{ok, pid, version, ready}` (`ready`: the React root rendered).
- `POST /eval {js, timeoutMs}` -> `{ok, value}` or `{ok:false, error}`. `js` is the body of an async function; the page
  answers with a `test-bridge-result` event. A timed-out eval is **not cancelled** and an eval sent before the page has
  loaded can run later, so `connect()`, then `wait_ready()`, and keep snippets idempotent.
- `GET /window` -> `{windowId, title, minimized, visible, key, appActive, onScreen}`: a **read-only** GET.
  `windowId` is the `NSWindow.windowNumber` for `screencapture -x -o -l <id>`.
- **There is no snapshot endpoint yet** (screenshots go through `screencapture`, see the gaps below).

`scripts/bridge.py` (stdlib) wraps it: `Bridge.connect()`, `wait_ready()`, `eval`, `expr`, `window`, `screenshot`,
`open_note`, `set_mode`, `press`, `type_text`, `save`, `click`, `ui`, `wait_for`, `request_close(from_os=False)`, `quit()`.
`scripts/e2e-example.py` drives it on a scratch vault. Its own measurements: dispatched clicks, Cmd+E/Cmd+S keydowns,
`el.focus()` and `execCommand('insertText')` on the editor work unfocused; a synthetic plain-character `keydown` or
`beforeinput` does not insert text (use `execCommand`); CodeMirror reports no focus while the document has none; the
native folder dialog and native menu cannot be driven from the DOM.

**Quitting without activating (important).** The app activates itself on any macOS-initiated quit, so do **not** quit
through AppleScript, the Dock or the menu. Use:
- `Bridge.quit()`: emits the same `close-confirmed` event the modal's Save/Discard answers; refuses while there are
  unsaved changes (it falls back to SIGTERM of the pid from the discovery file).
- `Bridge.request_close(from_os=True)` to **raise the unsaved-changes modal** as if macOS had asked to quit (it emits
  `close-requested` with `fromOs: true`), then check `document.activeElement` is Cancel and answer through `eval`.
A genuine OS quit (Dock/AppleScript/logout path through `applicationShouldTerminate:`) is verified only inside
`focus-guard --foreground --watch-pid <pid>`, or left for a human.

**Typical session** (claim: "an OS-originated quit with unsaved text focuses Cancel and Return does not save"):
1. Layer 0: unit tests and `/verify-app` on `pnpm dev` (mockIPC). Cheap, do first.
2. `pnpm build:bridge`; copy `fixtures/vault/` into a **private** scratch dir (`desktop_test.private_dir()`; the repo's
   own docs use `/private/tmp/myapp-bridge-*`, which is a predictable shared path, so prefer a `mkdtemp` dir); launch with
   `launch-bg "MyApp Bridge.app" --stderr "$SCRATCH/app.log"` (the identifier ends in `.test`, so it passes the id check;
   `--seed-state` refuses a data dir the harness did not create, so remove a stale bridge data dir first or let the
   bridge/`state.json` be set through `eval`).
3. Layer 1: `Bridge.connect()`, `wait_ready()`, make a dirty buffer through `eval`, `request_close(from_os=True)`,
   read the modal and `document.activeElement`; assert the file on disk is unchanged and no `.myapp-tmp-*` exists.
4. Layer 3/4 only for native chrome the DOM cannot reach; layer 2 for window chrome (see the gaps).
5. `Bridge.quit()` (or `bin/stop <pid>`); delete the scratch dir and the test data dir.

**Known gaps of this bridge against the probe findings (P4/P5).** These are fixes for the my-app repo, not the
harness; until they land:
- **rAF runs at 0 fps when the window is occluded.** The bridge's `settle()` (2 rAFs) can hang while another window
  covers the app. Race it against a timer.
- **`screencapture -l` shows the web area blank** for an occluded window, so `Bridge.screenshot()` of a covered window
  captures chrome only. The fix is an in-process `WKWebView.takeSnapshot` endpoint (verified here only for a static page).
- **Chained sleeps may slow to ~1 s per step** while hidden (unmeasured; the probe check exists but has not run), so
  scripted sequences of waits can time out.
- **CodeMirror's measuring stalls** while hidden (it depends on rAF/layout), so editor geometry-dependent assertions
  are unreliable until the window is visible.

**Report as manual:** the native folder-picker dialog (Change folder), Finder drops, real logout/shutdown, any TCC
prompt, a real OS-initiated quit, and a real HID click or Cmd+Q keypress when the user is active.

## 9. Harness reference

| Tool | What | Needs |
|---|---|---|
| `bin/focus-mode [-v]` | prints `background` / `foreground` | nothing |
| `bin/focus-guard` | run a step, record/restore frontmost app, fail on focus change | nothing |
| `bin/launch-bg` | `open -g -n` (or `Popen`), returns PID, asserts not frontmost, test-id and ownership checks, records the launch | nothing |
| `bin/stop` | stop a pid launch-bg recorded (pid, start time, bundle id must match) | nothing |
| `bin/capture-window` | `pid:N` / `wid:N` to PNG via `screencapture -x -o -l` | Screen Recording |
| `bin/dtool winlist\|pkey\|pclick\|pscroll\|ax\|sckshot\|hidclick\|displays\|session` | on-demand Swift tools; input tools own-pid only, hidclick foreground only | Accessibility (pkey/pclick/pscroll/ax), Screen Recording (sckshot) |
| `lib/desktop_test.py` | stdlib Python API tying them together | |
| `fixtures/probe-app/` | `Probe.swift` + `build.sh` (private out dir) | `swiftc` |
| `probes/run_probes.py` | re-runs P1 to P6, writes results.json and focus.log into a fresh private dir | Accessibility, Screen Recording |
| `tests/test_harness.py` | static unit tests of the safety logic (`python3 -m unittest discover -s harness/tests`); launches nothing | `swiftc` |

Permissions are granted to the *calling process* (Terminal or the agent host), not to the tools. If a probe returns a
blank or "could not create image", check Screen Recording; if `ax`/`pkey` exit 3, check Accessibility.
`DESKTOP_TEST_CACHE`, `DESKTOP_TEST_SCRATCH` (extra scratch roots), `APP_TESTING_CONFIG`, `APP_TESTING_FOCUS` override defaults.
