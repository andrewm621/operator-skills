#!/usr/bin/env python3
"""run_probes.py: run probes P1-P6 of the desktop-app-testing playbook against the Probe fixture app.

  python3 run_probes.py [--out DIR]

Re-run this on a new macOS version (or a new WebView) to re-verify the facts in desktop-app-testing.guide.md.
It builds ../fixtures/probe-app/Probe.app (bundle id co.andrewmiller.desktop-probe) into a PRIVATE dir, starts only
its own instances, and never touches any other process.

Focus policy: every step here uses background-safe techniques only (PID-targeted events, AX by PID,
`screencapture -l`, `open -g`). Steps that would activate a window or post HID events run only when
`focus-mode` says foreground, and are otherwise recorded as "not run, user active". A watcher thread samples
`lsappinfo front` every 50 ms for the whole run and logs every change to focus.log.

Directories: by default a fresh tempfile.mkdtemp(prefix="desktop-probe-") dir (0700, random name). With --out the
dir must not exist yet (created 0700) or already be a private dir owned by you; a foreign or symlinked dir is refused.
The built app and the probe's command channel live inside it, because both are executed / read as commands.

Writes: <out>/results.json, <out>/results.md, <out>/focus.log, <out>/<probe>.log (app stderr), screenshots.
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
import desktop_test as dt  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--out", help="output dir; default: a fresh mkdtemp dir")
args = ap.parse_args()
RUN = dt.private_dir(args.out, prefix="desktop-probe-")
BUILD = dt.private_dir(RUN / "build")
APP = BUILD / "Probe.app"
WEB_REGION = (0.0, 0.14, 1.0, 0.40)   # where the probe page draws its heading/input/button, as window fractions
FRAME = "1500,900,520,360"   # global top-left points; level "back" keeps the window behind every normal window
subprocess.run([str(HERE.parent / "fixtures/probe-app/build.sh"), str(BUILD)], check=True, capture_output=True)
_other = [d for d in dt.displays() if not d["main"]]
# a free corner of a second display, if there is one: nothing of the user's usually covers it there
VFRAME = (f"{int(_other[0]['x'] + _other[0]['w'] - 560)},{int(_other[0]['y'] + _other[0]['h'] - 420)},520,360"
          if _other else None)

# ------------------------------------------------------------------ focus watcher
probe_pids: set[int] = set()
current = {"probe": "-"}
focus_events: list[dict] = []
stop_watch = threading.Event()
T0 = time.time()


def watcher():
    last = None
    while not stop_watch.is_set():
        f = dt.front_app()
        pid = f.get("pid")
        if pid != last:
            mine = pid in probe_pids
            focus_events.append({"t": round(time.time() - T0, 2), "during": current["probe"], "front_pid": pid,
                                 "who": "PROBE" if mine else "other-app"})
            last = pid
        time.sleep(0.05)


threading.Thread(target=watcher, daemon=True).start()
FOCUS_STEPS: list[dict] = []


def flog(probe: str, step: str) -> None:
    f = dt.front_app()
    FOCUS_STEPS.append({"t": round(time.time() - T0, 2), "probe": probe, "step": step, "front_pid": f.get("pid"),
                        "who": "PROBE" if f.get("pid") in probe_pids else "other-app",
                        "mode": dt.focus_mode(), "idle_s": round(dt.idle_seconds() or -1, 1)})


# ------------------------------------------------------------------ helpers
apps: list[dt.App] = []
results: list[dict] = []


def start(label, *extra, multiple=False) -> dt.App:
    current["probe"] = label
    a = dt.launch_bg(APP, args=list(extra), stderr_path=RUN / f"{label}.log", allow_multiple=multiple)
    probe_pids.add(a.pid)
    apps.append(a)
    return a


def events(a: dt.App) -> list[dict]:
    out = []
    for line in a.log():
        if line.startswith("{"):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def wait_for(a, pred, timeout=8):
    end = time.time() + timeout
    while time.time() < end:
        for e in events(a):
            if pred(e):
                return e
        time.sleep(0.15)
    raise dt.HarnessError(f"timeout waiting for event in {a.stderr_path}")


def geometry(a):
    launched = wait_for(a, lambda e: e["t"] == "launched")
    ready = wait_for(a, lambda e: e["t"] == "ready")
    wx, wy, ww, wh = launched["webScreen"]
    centre = lambda r: (wx + r["x"] + r["w"] / 2, wy + r["y"] + r["h"] / 2)
    nb = launched["nativeBtn"]
    return {"field": centre(ready["field"]), "web_btn": centre(ready["webBtn"]),
            "native_btn": (nb[0] + nb[2] / 2, nb[1] + nb[3] / 2), "window_number": launched["windowNumber"]}


def hand_back(a, prev):
    """If the probe grabbed the front, give it back to whoever had it (the watcher has already logged it)."""
    if a.front_is_me():
        dt.restore_front(prev)
        return True
    return False


def record(pid_, name, result, notes, **extra):
    results.append({"probe": pid_, "name": name, "result": result, "notes": notes, **extra})
    print(f"[{pid_}] {result}: {name} - {notes}", flush=True)


def count(a, since, **kv):
    return sum(1 for e in events(a)[since:] if all(e.get(k) == v for k, v in kv.items()))


# ------------------------------------------------------------------ P1 key into a backgrounded WKWebView field
def p1():
    a = start("P1", "--level", "back", "--frame", FRAME)
    geo = geometry(a)
    prev = dt.front_app()
    flog("P1", "before keys")
    n0 = len(events(a))
    dt.type_text(a.pid, "hello")
    dt.key(a.pid, "x")
    dt.key(a.pid, "return")
    time.sleep(1.0)
    flog("P1", "after keys")
    ev = events(a)[n0:]
    keys = [e for e in ev if e["t"] == "key"]
    downs = [e for e in keys if e["type"] == "keydown"]
    inputs = [e for e in keys if e["type"] == "input"]
    value = inputs[-1]["value"] if inputs else None
    trusted = all(e["trusted"] for e in keys) if keys else None
    docfocus = sorted({e["docFocus"] for e in keys})
    stole = hand_back(a, prev) or a.front_is_me()
    r = "works" if value == "hellox" else "partial" if downs else "doesn't"
    record("P1", "PID-targeted key into backgrounded WKWebView field", r,
           f"keydowns={len(downs)}, input value={value!r}, isTrusted={trusted}, document.hasFocus()={docfocus}, "
           f"probe took the front: {stole}. type_text (unicode string) and key (virtual keycode) both posted via CGEventPostToPid.")
    a.quit()


# ------------------------------------------------------------------ P2 PID-targeted click, acceptsFirstMouse 0 / 1
def p2():
    placements = [("occluded, level back", ["--level", "back", "--frame", FRAME])]
    if VFRAME:
        placements.append(("not occluded, alpha 0.01 on a free spot of the second display", ["--alpha", "0.01", "--frame", VFRAME]))
    for where, placement in placements:
        for flag in ("0", "1"):
            label = f"P2-afm{flag}-{'free' if 'not' in where else 'back'}"
            a = start(label, *placement, "--accept-first-mouse", flag, "--yield-on-activate")
            geo = geometry(a)
            wid = a.window()["id"]
            prev = dt.front_app()
            flog(label, "before clicks")
            out = {}
            for name, pt, use_wid in (("web button, no windowId", geo["web_btn"], None),
                                      ("web button, windowId stamped", geo["web_btn"], wid),
                                      ("native NSButton, windowId stamped", geo["native_btn"], wid)):
                n0 = len(events(a))
                dt.click(a.pid, pt[0], pt[1], window_id=use_wid)
                time.sleep(1.0)
                ak = [e for e in events(a)[n0:] if e["t"] == "appkit-event" and e["type"] in ("1", "2")]
                out[name] = {"appkit_mouseDown": sum(1 for e in ak if e["type"] == "1"), "appkit_mouseUp": sum(1 for e in ak if e["type"] == "2"),
                             "with_window": sum(1 for e in ak if e["window"] != 0),
                             "dom_mousedown": count(a, n0, t="mouse", type="mousedown"),
                             "web_btn_clicks": count(a, n0, t="web-btn"), "native_pings": count(a, n0, t="native-ping"),
                             "app_became_active": count(a, n0, t="app-active")}
                hand_back(a, prev)
            flog(label, "after clicks")
            delivered = any(v["web_btn_clicks"] or v["native_pings"] for v in out.values())
            activated = any(v["app_became_active"] for v in out.values())
            record("P2", f"PID-targeted click, acceptsFirstMouse={'true' if flag == '1' else 'false'}, window {where}",
                   "works" if delivered else "doesn't",
                   f"click acted on (DOM or NSButton)={delivered}, app activated by a click={activated}; detail={json.dumps(out)}",
                   accept_first_mouse=flag == "1", placement=where)
            a.quit()
            time.sleep(0.5)


# ------------------------------------------------------------------ P3 AX tree + AXPress while not frontmost
def p3():
    a = start("P3", "--level", "back", "--frame", FRAME)
    geo = geometry(a)
    prev = dt.front_app()
    flog("P3", "before ax")
    stages = []

    def poll(label, tries=10):
        """Dump the tree once a second until the web button shows up (WebKit builds web AX lazily)."""
        t = ""
        for i in range(1, tries + 1):
            t = dt.ax_tree(a.pid, 12)
            if i == 1 and label == "no extra step":
                (RUN / "P3-ax-tree-first-dump.txt").write_text(t)
            if "Web Ping" in t:
                stages.append({"stage": label, "dumps_needed": i, "AXWebArea": "AXWebArea" in t, "Web Ping": True})
                return t
            time.sleep(1.0)
        stages.append({"stage": label, "dumps_needed": None, "AXWebArea": "AXWebArea" in t, "Web Ping": False})
        return t

    tree = poll("no extra step")
    if "Web Ping" not in tree:
        stages[-1]["note"] = "gave up after 10 dumps; trying AXManualAccessibility"
        dt.ax_enable(a.pid, "AXManualAccessibility")
        tree = poll("after setting AXManualAccessibility")
    (RUN / "P3-ax-tree-final.txt").write_text(tree)
    has_web, has_web_btn = "AXWebArea" in tree, "Web Ping" in tree
    res = {}
    for name, role, title, pred in (("web button", "AXButton", "Web Ping", lambda e: e["t"] == "web-btn"),
                                    ("native button", "AXButton", "Native Ping", lambda e: e["t"] == "native-ping"),
                                    ("menu item", "AXMenuItem", "Native Menu Ping", lambda e: e["t"] == "native-ping")):
        n0 = len(events(a))
        try:
            out = dt.ax_press(a.pid, role, title)
        except dt.HarnessError as e:
            out = f"failed: {e}"
        time.sleep(0.8)
        res[name] = {"ax": out, "event_seen": any(pred(e) for e in events(a)[n0:]), "dom_mouse_events": count(a, n0, t="mouse"), "dom_trusted": sorted({e["trusted"] for e in events(a)[n0:] if e["t"] == "mouse"})}
    flog("P3", "after ax")
    activated = count(a, 0, t="app-active")
    hand_back(a, prev)
    r = "works" if res["native button"]["event_seen"] and res["menu item"]["event_seen"] else "partial"
    web_ok = res["web button"]["event_seen"]
    record("P3", "AX tree dump + AXPress by PID while not frontmost", r,
           f"WKWebView content in AX tree: AXWebArea={has_web}, 'Web Ping' button={has_web_btn}; stages={json.dumps(stages)}; "
           f"AXPress -> {json.dumps(res)}; app activations={activated}. Trees: P3-ax-tree*.txt (not committed)")
    a.quit()


# ------------------------------------------------------------------ P4 + P5 occlusion, throttling and capture
def capture_both(a, label):
    w = dt.main_window(a.pid)
    out = {"window": {k: w[k] for k in ("id", "x", "y", "w", "h", "onscreen", "minimized")}}
    for how in ("screencapture", "sck"):
        png = RUN / f"P5-{label}-{how}.png"
        try:
            if how == "screencapture":
                dt.capture(w["id"], png)
            else:
                dt.tool("sckshot", w["id"], png)
            out[how] = dt.png_stats(png)
            out[how]["web_region_distinct"] = dt.png_stats(png, crop=WEB_REGION)["distinct"]
        except Exception as e:  # noqa: BLE001
            out[how] = {"error": str(e)[:160]}
    return out


def p45():
    states = []
    shots = {}
    def launch_state(label, *extra, multiple=False):
        current["probe"] = label
        a = dt.launch_bg(APP, args=list(extra), stderr_path=RUN / f"{label}.log", allow_multiple=multiple)
        probe_pids.add(a.pid)
        apps.append(a)
        return a

    def cmdfile(label):
        """A private (0700, mine) command-channel dir per probe instance, passed explicitly on argv."""
        return ["--cmd-dir", str(dt.private_dir(RUN / f"cmd-{label}"))]

    def send(label, text):
        """Atomically drop DIR/cmd.js (tmp + rename) so the probe never reads half a command."""
        d = RUN / f"cmd-{label}"
        tmp = d / ".cmd.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.replace(tmp, d / "cmd.js")

    def observe_with(a, label, cmdlabel, secs):
        n0 = len(events(a))
        time.sleep(secs / 2)
        send(cmdlabel, "return 1 + 1")
        time.sleep(0.6)
        send(cmdlabel, "const t = performance.now(); await new Promise(r => setTimeout(r, 50)); const st = Math.round(performance.now() - t); "
                           "const mc = await new Promise(r => { const c = new MessageChannel(); const s = performance.now(); "
                           "c.port1.onmessage = () => r(Math.round(performance.now() - s)); c.port2.postMessage(0); }); "
                           "return 'setTimeout50=' + st + 'ms messageChannel=' + mc + 'ms'")
        time.sleep(1.6)
        send(cmdlabel, "return await Promise.race([new Promise(r => requestAnimationFrame(() => r('raf-ok'))), "
                           "new Promise(r => setTimeout(() => r('raf-timeout-3s'), 3000))])")
        time.sleep(secs / 2 + 3.4)
        snap_name = f"snap-{a.pid}-{int(time.time() * 1000)}.png"
        snap = RUN / f"cmd-{cmdlabel}" / snap_name
        send(cmdlabel, f"#snapshot {snap_name}")
        time.sleep(1.3)
        ev = events(a)[n0:]
        raf = [e["fps"] for e in ev if e["t"] == "raf"]
        tim = [e["per_s"] for e in ev if e["t"] == "timer"]
        st = [e for e in ev if e["t"] == "native-state"]
        evs = [e for e in ev if e["t"] == "eval"]
        snap_ev = next((e for e in evs if "snapshot" in str(e.get("result") or e.get("error"))), None)
        snap_info = None
        if snap_ev and snap.exists():
            ps = dt.png_stats(snap)
            snap_info = {"ms": snap_ev["elapsed_ms"], "distinct": ps["distinct"], "page_content": ps["distinct"] > 20}
        elif snap_ev:
            snap_info = {"error": snap_ev.get("error")}
        return {"state": label, "visibilityState": sorted({e["vis"] for e in ev if e["t"] == "raf"}),
                "raf_fps_median": statistics.median(raf) if raf else None,
                "timer_per_s_median": statistics.median(tim) if tim else None,
                "native_occluded": sorted({e["occluded"] for e in st}), "native_active": sorted({e["active"] for e in st}),
                "eval_sync_ms": next((e["elapsed_ms"] for e in evs if e.get("result") == "2"), None),
                "in_process_snapshot": snap_info,
                "eval_timing": next((e.get("result") for e in evs if "setTimeout50" in str(e.get("result"))), None),
                "eval_raf": next(({"ms": e["elapsed_ms"], "result": e.get("result")} for e in evs if "raf" in str(e.get("result"))), None)}

    prev = dt.front_app()
    other = _other
    vframe = VFRAME or FRAME
    # V: level "back" on a free spot of the SECOND display (nothing of the user's covers it there)
    if other:
        v = launch_state("P45-V", "--level", "back", "--frame", vframe, *cmdfile("P45-V"))
        geometry(v)
        flog("P4", "V launched (second display, level back)")
        st = observe_with(v, "V level-back on a second display", "P45-V", 4)
        states.append(st)
        shots["V level-back on a second display"] = capture_both(v, "V")
        v.quit()
    else:
        states.append({"state": "V visible baseline", "result": "not run, no second display"})
    # G: "ghost" window: normal level, alpha 0, ignores the mouse -> invisible and click-through. Whether it is
    # "visible" to WebKit depends only on whether another window covers it, so try a free spot (second display)
    # and the main display, where the user's windows are.
    for gl, gframe in (("G ghost on the second display (free desktop area)", vframe), ("G2 ghost on the main display (user windows above it)", FRAME)):
        g = launch_state("P45-" + gl[:2].strip(), "--alpha", "0.0", "--ignore-mouse", "--frame", gframe, *cmdfile("P45-" + gl[:2].strip()))
        geometry(g)
        flog("P4", f"{gl[:2].strip()} launched (ghost: alpha 0, ignore-mouse)")
        states.append(observe_with(g, gl, f"P45-{gl[:2].strip()}", 4))
        shots[gl] = capture_both(g, gl[:2].strip())
        n0 = len(events(g))
        dt.type_text(g.pid, "ab")
        time.sleep(0.6)
        states[-1]["pid_keys_into_ghost"] = [e.get("value") for e in events(g)[n0:] if e["t"] == "key" and e["type"] == "input"]
        hand_back(g, prev)
        g.quit()
    # A: behind everything, uncovered or not depending on the user's windows
    a = launch_state("P45-A", "--level", "back", "--frame", FRAME, *cmdfile("P45-A"))
    geometry(a)
    flog("P4", "A launched")
    states.append(observe_with(a, "A level-back, on-screen", "P45-A", 4))
    shots["A level-back, on-screen"] = capture_both(a, "A")
    # B: covered by a second probe window at the same level and frame (deterministic occlusion, no user window needed)
    b = launch_state("P45-B", "--level", "back", "--frame", FRAME, "--title", "Occluder", multiple=True)
    geometry(b)
    flog("P4", "B (occluder) launched")
    states.append(observe_with(a, "B occluded by sibling window", "P45-A", 4))
    shots["B occluded by sibling window"] = capture_both(a, "B")
    b.quit(); a.quit()
    # C: off-screen
    c = launch_state("P45-C", "--level", "back", "--frame", "-6000,200,520,360", *cmdfile("P45-C"))
    geometry(c)
    flog("P4", "C launched")
    wc = dt.main_window(c.pid)
    states.append(observe_with(c, "C off-screen (x=-6000)", "P45-C", 4))
    states[-1]["window_reported"] = {k: wc[k] for k in ("x", "y", "onscreen")}
    shots["C off-screen (x=-6000)"] = capture_both(c, "C")
    c.quit()
    # D: minimized via AX by PID
    d = launch_state("P45-D", "--level", "back", "--frame", FRAME, *cmdfile("P45-D"))
    geometry(d)
    flog("P4", "D launched")
    res = dt.ax_set_window_attr(d.pid, "AXMinimized", "true")
    time.sleep(1.2)
    flog("P4", "D minimized")
    states.append(observe_with(d, "D minimized (AXMinimized by PID)", "P45-D", 4))
    states[-1]["ax_set"] = res
    shots["D minimized (AXMinimized by PID)"] = capture_both(d, "D")
    flog("P4", "D done")
    hand_back(d, prev)
    d.quit()
    states.append({"state": "E on another Space / visible-frontmost baseline",
                   "result": "not run, user active (switching Spaces or activating the probe would disturb the user)"})
    for s in states:
        print("  P4 state:", json.dumps(s), flush=True)
    for k, v in shots.items():
        print("  P5 capture:", k, json.dumps(v), flush=True)
    record("P4", "visibilityState + rAF/timer cadence + JS eval when occluded / offscreen / minimized", "measured",
           "see states", states=states)
    record("P5", "screencapture -l vs ScreenCaptureKit on occluded / offscreen / minimized windows", "measured",
           "see captures", captures=shots)


# ------------------------------------------------------------------ P6 open -g cold launch vs lsappinfo front
def p6():
    trace = []
    for i in range(3):
        current["probe"] = f"P6-{i}"
        prev = dt.front_app()
        flog(f"P6-{i}", "before open -g -n")
        samples, stop = [], threading.Event()

        def sample():
            t0 = time.time()
            while not stop.is_set():
                samples.append((round(time.time() - t0, 3), dt.front_app().get("pid")))
                time.sleep(0.025)
        th = threading.Thread(target=sample, daemon=True)
        th.start()
        t0 = time.time()
        try:
            a = start(f"P6-{i}", "--level", "back", "--frame", FRAME)
            win_after = round(time.time() - t0, 2)
            err = None
        except dt.HarnessError as e:
            a, win_after, err = None, None, str(e)
        time.sleep(2.5)
        stop.set(); th.join()
        flog(f"P6-{i}", "after launch + 2.5s")
        pids = {p for _, p in samples}
        was_front = any(p in probe_pids for p in pids)
        trace.append({"run": i, "samples": len(samples), "probe_was_frontmost": was_front, "launch_error": err,
                      "window_visible_after_s": win_after, "front_pids_seen": len(pids)})
        if a:
            hand_back(a, prev)
            a.quit()
        time.sleep(0.5)
    ever = any(t["probe_was_frontmost"] for t in trace)
    record("P6", "`open -g -n` cold launch vs `lsappinfo front` (25 ms sampling for ~5 s)", "doesn't steal focus" if not ever else "STOLE FOCUS",
           f"{json.dumps(trace)}. `open` without -g and a bare-executable Popen launch: not run, user active "
           f"(they can activate the app).", runs=trace)


def main():
    steps = [("P1", p1), ("P2", p2), ("P3", p3), ("P45", p45), ("P6", p6)]
    for name, fn in steps:
        try:
            flog(name, "start")
            fn()
        except Exception as e:  # noqa: BLE001
            record(name, "probe crashed", "error", f"{type(e).__name__}: {e}")
        finally:
            flog(name, "end")
            for a_ in apps:
                if a_.alive():
                    a_.quit()
            apps.clear()
            time.sleep(0.5)
    for a in apps:
        if a.alive():
            a.quit()
    time.sleep(0.5)
    stop_watch.set()
    probe_front = [e for e in focus_events if e["who"] == "PROBE"]
    summary = {"focus_mode_at_end": dt.focus_mode(), "probe_pids": sorted(probe_pids),
               "times_probe_was_frontmost": len(probe_front), "probe_front_events": probe_front,
               "front_changes_total": len(focus_events)}
    (RUN / "results.json").write_text(json.dumps({"results": results, "focus_summary": summary}, indent=2))
    with open(RUN / "focus.log", "w") as fh:
        fh.write("# lsappinfo front: step samples (before/after each probe step)\n")
        for s in FOCUS_STEPS:
            fh.write(json.dumps(s) + "\n")
        fh.write("# watcher: every change of the frontmost app during the run (50 ms sampling); other apps are anonymised\n")
        for e in focus_events:
            fh.write(json.dumps(e) + "\n")
    print(json.dumps(summary, indent=2))


main()
