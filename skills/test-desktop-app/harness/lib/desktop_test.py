"""desktop_test: stdlib-only helpers for testing a local macOS app without disturbing the user.

Pieces (see ../../desktop-app-testing.guide.md for when to use each):
  - focus policy      : focus_mode(), front_app(), restore_front()
  - swift tools       : tool("winlist", ...) compiles ../swift/<name>.swift on demand into a cache dir
  - windows / capture : windows(pid), main_window(pid), capture(window_id, out_png)
  - PID-targeted input: key(pid, ...), type_text(pid, ...), click(pid, ...), scroll(pid, ...)   (own PIDs only)
  - AX                : ax_tree(pid), ax_press(pid, ..., exact=True)
  - lifecycle         : launch_bg(...) -> App; App.quit()/App.kill() only ever touch PIDs this process started

Nothing here activates a window, moves the real cursor or posts HID-level events. The only HID-level
path is hid_click() (tool "hidclick"), which tool() refuses unless focus_mode() == "foreground".
Input tools (pkey, pclick, pscroll, ax press/set/enable) refuse any pid that launch_bg did not record.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import plistlib
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent
SWIFT_DIR = HARNESS / "swift"
# compiled Swift tools are EXECUTED, so the cache must be user-private (never a shared /tmp path)
CACHE = Path(os.environ.get("DESKTOP_TEST_CACHE", "~/Library/Caches/desktop-app-testing")).expanduser()
CONFIG = Path(os.environ.get("APP_TESTING_CONFIG", "~/.claude/app-testing.json")).expanduser()
DEFAULT_CONFIG = {"focus": "auto", "idleMinutes": 5}

# PIDs this process started. kill/quit refuse anything else.
_STARTED: set[int] = set()


class HarnessError(RuntimeError):
    pass


# --------------------------------------------------------------------------- focus policy

class ConfigError(HarnessError):
    pass


def load_config() -> dict:
    """The config file merged over the defaults. A missing file means the defaults; a file that exists but is not a
    JSON object raises ConfigError (focus_mode() turns that into 'background')."""
    cfg = dict(DEFAULT_CONFIG)
    try:
        text = CONFIG.read_text()
    except FileNotFoundError:
        return cfg
    except OSError as e:
        raise ConfigError(f"cannot read {CONFIG}: {e}")
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ConfigError(f"{CONFIG} is not valid JSON: {e}")
    if not isinstance(data, dict):
        raise ConfigError(f"{CONFIG} must contain a JSON object")
    cfg.update(data)
    return cfg


def idle_seconds() -> float | None:
    """Seconds since the last HID input (keyboard/mouse), or None if it cannot be read.
    NOTE: input the harness itself posts at the HID level (hidclick) resets this clock, so after a foreground step
    the next `auto` check will say background until the user is idle again."""
    try:
        out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', out)
    return int(m.group(1)) / 1e9 if m else None


def session_blocked() -> bool:
    """True when nobody can be at the screen: no GUI session, screen locked, not on the console, or loginwindow is
    the frontmost app. Raises on any failure (focus_mode() turns that into background)."""
    sess = json.loads(tool("session").stdout)
    if not sess.get("present") or sess.get("locked") or not sess.get("onConsole"):
        return True
    front = front_app()
    return front.get("bundle") == "com.apple.loginwindow" or front.get("name") == "loginwindow"


def _idle_minutes(cfg: dict) -> float:
    v = cfg.get("idleMinutes")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
        raise ConfigError(f"idleMinutes must be a finite number >= 0, got {v!r}")
    return float(v)


def focus_mode() -> str:
    """'background' or 'foreground'. FAILS SAFE: anything unexpected is 'background'.

    Config ~/.claude/app-testing.json {"focus": ..., "idleMinutes": N}; APP_TESTING_FOCUS (non-empty) overrides
    "focus". Only the exact strings "background", "foreground", "auto" mean something; any other value (typo, wrong
    case, non-string) is background. "auto" is foreground only if HIDIdleTime >= idleMinutes. A locked screen, no GUI
    session, or loginwindow in front is background in every mode. Any exception at all returns background."""
    try:
        cfg = load_config()
        mode = os.environ.get("APP_TESTING_FOCUS") or cfg.get("focus")
        if not isinstance(mode, str) or mode not in ("background", "foreground", "auto"):
            return "background"
        if mode == "background":
            return "background"
        if session_blocked():
            return "background"
        if mode == "foreground":
            return "foreground"
        idle = idle_seconds()
        if idle is None:
            return "background"
        return "foreground" if idle >= _idle_minutes(cfg) * 60 else "background"
    except Exception:  # noqa: BLE001 - the safe answer for every failure is "do not touch the user's screen"
        return "background"


def require_foreground(what: str) -> None:
    if focus_mode() != "foreground":
        raise HarnessError(f"{what}: needs the foreground and the user is active or away from a locked screen (not run)")


def front_app() -> dict:
    """The frontmost app: {asn, pid, bundle, name}. Empty values if lsappinfo gives nothing."""
    asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
    info = {"asn": asn, "pid": None, "bundle": None, "name": None}
    if not asn:
        return info
    out = subprocess.run(["lsappinfo", "info", "-only", "pid", "-only", "bundleid", "-only", "name", asn],
                         capture_output=True, text=True).stdout
    for key, field in (("pid", "pid"), ("CFBundleIdentifier", "bundle"), ("LSDisplayName", "name")):
        m = re.search(rf'"{key}"\s*=\s*"?([^"\n]+)"?', out)
        if m:
            info[field] = int(m.group(1)) if field == "pid" else m.group(1)
    return info


def restore_front(prev: dict) -> bool:
    """Bring the previously frontmost app back (by bundle id, only if it is still running)."""
    if not prev.get("bundle") or not prev.get("pid"):
        return False
    if subprocess.run(["kill", "-0", str(prev["pid"])], capture_output=True).returncode != 0:
        return False
    subprocess.run(["open", "-b", prev["bundle"]], capture_output=True)
    time.sleep(0.4)
    return front_app().get("pid") == prev["pid"]


def front_matches(front: dict, pids=(), bundles=()) -> bool:
    return front.get("pid") in set(pids) or (bool(front.get("bundle")) and front.get("bundle") in set(bundles))


def guard_evaluate(before: dict, samples: list[dict], pids=(), bundles=()) -> dict:
    """Pure decision logic of focus-guard. `samples` = every frontmost app seen during and after the step.

    changed       : any sample differs from `before`
    to_watched    : any sample is a watched pid/bundle (only possible with a watch list)
    restore       : the LAST sample is still a watched app, i.e. we must hand the front back. A change to some other
                    app (the user switching) is never restored; without a watch list nothing is ever restored.
    attributed    : True / False with a watch list, None without one (cause unknown)"""
    watching = bool(pids or bundles)
    changed = any(f.get("pid") != before.get("pid") for f in samples)
    to_watched = watching and any(front_matches(f, pids, bundles) for f in samples)
    return {"watching": watching, "changed": changed, "to_watched": to_watched,
            "restore": bool(watching and samples and front_matches(samples[-1], pids, bundles)
                            and samples[-1].get("pid") != before.get("pid")),
            "attributed": to_watched if watching else None}


# --------------------------------------------------------------------------- scratch / path guards

def _is_private_dir(p: Path) -> bool:
    try:
        st = os.lstat(p)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and not (st.st_mode & 0o077)


def assert_private_dir(path: str | os.PathLike) -> Path:
    """Require a real directory (not a symlink) owned by this user with mode 0700. Use for anything that will be
    executed or read as commands (tool cache, build dir, command channel)."""
    p = Path(path)
    if not _is_private_dir(p):
        raise HarnessError(f"{p} is not a private dir (must be a real dir, owned by uid {os.getuid()}, mode 0700)")
    return p.resolve()


def private_dir(path: str | os.PathLike | None = None, prefix: str = "dat-") -> Path:
    """A fresh private dir. No path: tempfile.mkdtemp (random name, 0700). With a path: it must not exist yet (it is
    created 0700, parents as needed) or already be a private dir owned by you. Never adopts a foreign dir."""
    if path is None:
        return assert_private_dir(tempfile.mkdtemp(prefix=prefix))
    p = Path(path).expanduser()
    if os.path.lexists(p):
        return assert_private_dir(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    os.mkdir(p, 0o700)
    os.chmod(p, 0o700)
    return assert_private_dir(p)


def _trusted_owner(st) -> bool:
    return st.st_uid in (0, os.getuid())


def assert_owned_executable(path: str | os.PathLike) -> None:
    """Refuse to launch a bundle/executable another user could have planted or can modify. Checked:
      - every parent directory up to /: owned by root or you, not world-writable unless sticky (/tmp style), and
        not group-writable unless root-owned (system dirs such as /Applications);
      - the target itself (the .app dir, or the executable): owned by root or you, not group/world-writable;
      - for an .app also Contents, Contents/MacOS, every entry in MacOS, Contents/Frameworks and its top-level
        entries; a symlink there is followed and its REAL target (and that target's dir) must pass the same test.
    Not checked: files deeper inside Frameworks/Resources, and code signing."""
    p = Path(path)

    def bad(c, why):
        raise HarnessError(f"refusing to launch {p}: {c} {why}")

    for q in p.parents:
        st = os.stat(q)
        if not _trusted_owner(st):
            bad(q, "is not owned by you or root")
        if st.st_mode & 0o002 and not st.st_mode & stat.S_ISVTX:
            bad(q, "is world-writable (and not sticky)")
        if st.st_mode & 0o020 and st.st_uid != 0 and not st.st_mode & stat.S_ISVTX:
            bad(q, "is group-writable")

    def check(c: Path, follow_links=True):
        st = os.lstat(c)
        if stat.S_ISLNK(st.st_mode):
            if not _trusted_owner(st):
                bad(c, "is a symlink not owned by you or root")
            if follow_links:
                real = Path(os.path.realpath(c))
                check(real, follow_links=False)
                check(real.parent, follow_links=False)
            return
        if not _trusted_owner(st) or st.st_mode & 0o022:
            bad(c, "is not owned by you/root or is group/world-writable")

    check(p)
    if p.suffix == ".app":
        contents = p / "Contents"
        for d in (contents, contents / "MacOS", contents / "Frameworks"):
            if d.exists() or d.is_symlink():
                check(d)
                if d.is_dir():
                    for e in sorted(d.iterdir()) if d.name in ("MacOS", "Frameworks") else []:
                        check(e)


def scratch_roots() -> list[Path]:
    """Roots under which scratch DATA copies may live. Shared /tmp is allowed only if the first dir below it is
    private to you (see assert_scratch); never put anything executed or read as commands here, use private_dir()."""
    roots = [Path("/private/tmp"), Path(tempfile.gettempdir()).resolve()]
    extra = os.environ.get("DESKTOP_TEST_SCRATCH")
    if extra:
        roots += [Path(p).resolve() for p in extra.split(":") if p]
    return roots


def assert_scratch(path: str | os.PathLike) -> Path:
    """Refuse any path that is not inside a scratch root, and (for shared roots like /private/tmp) any path whose
    top-level directory below the root exists but is not owned by you / is group- or world-writable
    (a pre-created foreign dir). Validate before creating or seeding anything."""
    p = Path(path).expanduser().resolve()
    root = next((r for r in scratch_roots() if r in p.parents), None)
    if root is None:
        raise HarnessError(f"{p} is not under a scratch root {[str(r) for r in scratch_roots()]}")
    top = root / p.relative_to(root).parts[0]
    if os.path.lexists(top):
        st = os.lstat(top)
        if st.st_uid != os.getuid() or st.st_mode & 0o022 or stat.S_ISLNK(st.st_mode):
            raise HarnessError(f"{top} exists but is not yours / is writable by others / is a symlink; refusing")
    return p


def scratch_copy(src: str | os.PathLike, dest: str | os.PathLike) -> Path:
    """Copy test data into scratch (symlinks kept as links). The source is only ever read."""
    dest = assert_scratch(dest)
    if dest.exists():
        subprocess.run(["chmod", "-R", "u+w", str(dest)], capture_output=True)
        shutil.rmtree(dest)
    shutil.copytree(src, dest, symlinks=True)
    return dest


# A test build's bundle id must END in a test marker segment: co.acme.app.test, ...-probe, .e2e, .bridge, .refusal-check.
# (Containing "test"/"dev" anywhere is not enough: com.test.realapp and dev.zed.Zed are real apps.)
TEST_ID = re.compile(r"[.\-](test|e2e|probe|bridge|refusal-check)$")


def data_dir(bundle_id: str) -> Path:
    return Path("~/Library/Application Support").expanduser() / bundle_id


def running_with_bundle(bundle_id: str) -> list[int]:
    out = subprocess.run(["lsappinfo", "list"], capture_output=True, text=True).stdout
    pids = []
    for block in re.split(r"\n(?=\s*\d+\) )", out):
        if f'bundleID="{bundle_id}"'.lower() in block.lower():
            m = re.search(r"pid = (\d+)", block)
            if m:
                pids.append(int(m.group(1)))
    return pids


# --------------------------------------------------------------------------- swift tools

TOOLS = frozenset({"winlist", "displays", "session", "sckshot", "pkey", "pclick", "pscroll", "ax", "hidclick"})
PID_INPUT_TOOLS = frozenset({"pkey", "pclick", "pscroll"})


def tool(name: str, *args: str, check: bool = True, timeout: float = 30) -> subprocess.CompletedProcess:
    """Run swift/<name>.swift (compiled once into the private cache dir, keyed by source hash).

    `name` is reduced to its lowercase basename and must be on the TOOLS allow-list (so HIDCLICK, ./hidclick and
    hidclick are all 'hidclick', and anything else is refused). Gates enforced HERE, for every caller:
      - hidclick: focus_mode() must be 'foreground'; the run gets a one-shot DESKTOP_TEST_HID_OK token that the Swift
        binary itself requires;
      - pkey / pclick / pscroll and `ax press|set|enable`: the pid (first arg) must be one launch_bg recorded."""
    canon = os.path.basename(str(name)).lower()
    if canon not in TOOLS:
        raise HarnessError(f"unknown tool {name!r}")
    env = None
    if canon == "hidclick":
        require_foreground("hidclick")
        env = {**os.environ, "DESKTOP_TEST_HID_OK": f"{os.getpid()}:{time.time():.0f}"}
    if canon in PID_INPUT_TOOLS or (canon == "ax" and len(args) > 1 and str(args[1]) in ("press", "set", "enable")):
        assert_own_pid(int(args[0]))
    src = SWIFT_DIR / f"{canon}.swift"
    digest = hashlib.sha256(src.read_bytes()).hexdigest()[:10]
    cache = private_dir(CACHE)
    exe = cache / f"{canon}-{digest}"
    if not exe.exists():
        tmp = cache / f"{canon}-{digest}.tmp{os.getpid()}"
        r = subprocess.run(["swiftc", "-O", "-o", str(tmp), str(src)], capture_output=True, text=True)
        if r.returncode != 0:
            raise HarnessError(f"swiftc failed for {canon}:\n{r.stderr}")
        os.replace(tmp, exe)
    r = subprocess.run([str(exe), *map(str, args)], capture_output=True, text=True, timeout=timeout, env=env)
    if check and r.returncode != 0:
        raise HarnessError(f"{canon} {' '.join(map(str, args))} -> rc {r.returncode}: {r.stderr.strip()}")
    return r


# ---- own-PID records: only processes launch_bg started (same pid, same start time, same bundle id) may be driven

def _proc_start(pid: int) -> str | None:
    out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return out or None


def _proc_comm(pid: int) -> str | None:
    out = subprocess.run(["ps", "-o", "comm=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return out or None


def _live_bundle(pid: int) -> str | None:
    asn = subprocess.run(["lsappinfo", "find", f"pid={pid}"], capture_output=True, text=True).stdout.strip()
    if not asn:
        return None
    out = subprocess.run(["lsappinfo", "info", "-only", "bundleid", asn], capture_output=True, text=True).stdout
    m = re.search(r'"CFBundleIdentifier"\s*=\s*"?([^"\n]+)"?', out)
    return m.group(1) if m else None


def _launch_dir() -> Path:
    return private_dir(private_dir(CACHE) / "launches")


def record_launch(pid: int, bundle_id: str | None) -> None:
    rec = {"pid": pid, "bundle_id": bundle_id, "start_time": _proc_start(pid), "comm": _proc_comm(pid)}
    path = _launch_dir() / f"{pid}.json"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(rec, fh)


def forget_launch(pid: int) -> None:
    try:
        os.unlink(_launch_dir() / f"{pid}.json")
    except OSError:
        pass


def assert_own_pid(pid: int) -> dict:
    """Refuse any pid that launch_bg did not record. The record holds pid, start time, bundle id and executable; all
    must still match the live process, which also catches pid reuse."""
    path = _launch_dir() / f"{int(pid)}.json"
    try:
        rec = json.loads(path.read_text())
    except (OSError, ValueError):
        raise HarnessError(f"refusing pid {pid}: not started by launch_bg (no launch record)")
    if not rec.get("start_time") or _proc_start(pid) != rec["start_time"]:
        raise HarnessError(f"refusing pid {pid}: start time differs from the record (pid reuse or the process is gone)")
    if rec.get("comm") and _proc_comm(pid) != rec["comm"]:
        raise HarnessError(f"refusing pid {pid}: executable differs from the record")
    live = _live_bundle(pid)
    if live is not None and rec.get("bundle_id") and live != rec["bundle_id"]:
        raise HarnessError(f"refusing pid {pid}: bundle id {live!r} differs from the record {rec['bundle_id']!r}")
    return rec


def windows(pid: int) -> list[dict]:
    """Every window owned by pid (incl. off-screen and minimized): id, title, layer, x, y, w, h, onscreen, minimized."""
    return json.loads(tool("winlist", pid).stdout or "[]")


def displays() -> list[dict]:
    """Active displays in global top-left points: main, x, y, w, h."""
    return json.loads(tool("displays").stdout)


def main_window(pid: int, min_w: float = 100, onscreen_only: bool = False) -> dict | None:
    """The app's real window: on-screen first, then titled, then biggest. Any layer (a window can sit at a
    desktop-level layer). Helper/overlay windows are often untitled, off-screen and layer 0, so do not assume layer 0."""
    cand = [w for w in windows(pid) if w["w"] >= min_w and w["h"] >= 50 and (w["onscreen"] or not onscreen_only)]
    return max(cand, key=lambda w: (w["onscreen"], bool(w["title"]), w["w"] * w["h"]), default=None)


def wait_window(pid: int, timeout: float = 15, **kw) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        w = main_window(pid, **kw)
        if w:
            return w
        time.sleep(0.25)
    raise HarnessError(f"no window for pid {pid} after {timeout}s")


def capture(window_id: int, out_png: str | os.PathLike) -> Path:
    """screencapture -x -o -l<id>: works when the window is occluded, takes no focus, no cursor."""
    out = Path(out_png)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.is_symlink():
        raise HarnessError(f"refusing to write the screenshot through a symlink: {out}")
    r = subprocess.run(["screencapture", "-x", "-o", f"-l{window_id}", str(out)], capture_output=True, text=True)
    if r.returncode != 0 or not out.exists() or out.stat().st_size < 500:
        raise HarnessError(f"screencapture window {window_id} failed rc={r.returncode} {r.stderr.strip()}")
    return out


# --------------------------------------------------------------------------- PID-targeted input

def key(pid: int, name: str, mods: str = "") -> None:
    """Key press posted to pid with CGEventPostToPid (no HID, no activation). mods: 'cmd,shift,alt,ctrl'."""
    tool("pkey", pid, "key", name, mods)


def type_text(pid: int, text: str) -> None:
    tool("pkey", pid, "type", text)


def click(pid: int, x: float, y: float, window_id: int | None = None, count: int = 1) -> None:
    """Click at GLOBAL screen point (x, y), posted to pid. Pass window_id so AppKit routes it to that window."""
    tool("pclick", pid, x, y, window_id or 0, count)


def scroll(pid: int, x: float, y: float, dy: int) -> None:
    tool("pscroll", pid, x, y, dy)


def ax_tree(pid: int, max_depth: int = 8, menubar: bool = False) -> str:
    return tool("ax", pid, "tree", max_depth, *([] if menubar else ["nomenu"])).stdout


def ax_enable(pid: int, attr: str = "AXManualAccessibility") -> str:
    """Ask a lazy AX implementation (WKWebView) to build its web-content tree."""
    return tool("ax", pid, "enable", attr).stdout.strip()


def ax_press(pid: int, role: str, title: str, exact: bool = True) -> str:
    """AXPress by role + title/desc/value. exact=True (default) matches the whole label, so "Quit" does not hit
    "Force Quit..." and "Save" does not hit "Save as copy"."""
    return tool("ax", pid, "press", role, title, *(["exact"] if exact else [])).stdout.strip()


def ax_set_window_attr(pid: int, attr: str, value: str) -> str:
    return tool("ax", pid, "set", attr, value).stdout.strip()


def hid_click(x: float, y: float) -> None:
    """REAL cursor move + click. Foreground mode only."""
    require_foreground("hid_click")
    tool("hidclick", x, y)


# --------------------------------------------------------------------------- lifecycle

class App:
    """A process this harness started. Only these PIDs can be quit or killed."""

    def __init__(self, pid: int, bundle_id: str | None, stderr_path: Path | None, bundle_path: Path | None,
                 front_before: dict, popen: subprocess.Popen | None = None):
        self.pid, self.bundle_id, self.stderr_path, self.bundle_path = pid, bundle_id, stderr_path, bundle_path
        self.front_before, self.popen = front_before, popen
        _STARTED.add(pid)

    def alive(self) -> bool:
        if self.popen is not None:
            return self.popen.poll() is None
        return subprocess.run(["kill", "-0", str(self.pid)], capture_output=True).returncode == 0

    def window(self, **kw) -> dict:
        return wait_window(self.pid, **kw)

    def shot(self, out_png, window_id: int | None = None) -> Path:
        return capture(window_id or self.window()["id"], out_png)

    def log(self) -> list[str]:
        try:
            return self.stderr_path.read_text(errors="replace").splitlines() if self.stderr_path else []
        except OSError:
            return []

    def front_is_me(self) -> bool:
        return front_app().get("pid") == self.pid

    def quit(self, timeout: float = 5) -> bool:
        """SIGTERM then SIGKILL, this PID only."""
        self._guard()
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if not self.alive():
                break
            os.kill(self.pid, sig)
            end = time.time() + timeout
            while self.alive() and time.time() < end:
                time.sleep(0.1)
        if not self.alive():
            forget_launch(self.pid)
        return not self.alive()

    kill = quit

    def _guard(self) -> None:
        if self.pid not in _STARTED:
            raise HarnessError(f"refusing to signal pid {self.pid}: not started by this harness")


def kill_pid(pid: int, timeout: float = 5) -> bool:
    """SIGTERM (then SIGKILL) a pid only if launch_bg recorded it and it still matches the record. Works across
    processes (bin/stop uses it)."""
    assert_own_pid(pid)
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            break
        end = time.time() + timeout
        while time.time() < end and subprocess.run(["kill", "-0", str(pid)], capture_output=True).returncode == 0:
            time.sleep(0.1)
    gone = subprocess.run(["kill", "-0", str(pid)], capture_output=True).returncode != 0
    if gone:
        forget_launch(pid)
    return gone


def _bundle_info(app: Path) -> dict:
    try:
        return plistlib.loads((app / "Contents/Info.plist").read_bytes())
    except (OSError, ValueError) as e:
        raise HarnessError(f"{app}: cannot read Info.plist ({e})")


def _bundle_exec(app: Path) -> Path:
    name = _bundle_info(app).get("CFBundleExecutable")
    if not name or "/" in name:
        raise HarnessError(f"{app}: Info.plist has no usable CFBundleExecutable")
    return app / "Contents/MacOS" / name


def _pids_exec(exe: Path) -> set[int]:
    """pids whose command IS this executable (not a sidecar/helper that merely lives under the same bundle)."""
    out = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True).stdout
    want, pids = str(exe), set()
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        cmd = cmd.strip()
        if pid.isdigit() and (cmd == want or cmd.startswith(want + " ")):
            pids.add(int(pid))
    return pids


def seed_state(bundle_id: str, specs: list[str]) -> Path:
    """Write test state into the TEST identifier's data dir. spec = '<json-or-source-file>:<relpath>'.

    Refuses a data dir the harness did not create (a real user's app state), and relpaths that escape it."""
    d = data_dir(bundle_id)
    marker = d / ".desktop-test-owned"
    if d.exists() and not marker.exists():
        raise HarnessError(f"{d} exists and was not created by the harness; refusing to seed it")
    d.mkdir(parents=True, exist_ok=True)
    marker.write_text("created by desktop-app-testing harness; safe to delete\n")
    for spec in specs:
        src, sep, rel = spec.rpartition(":")
        if not sep or not src or not re.fullmatch(r"[A-Za-z0-9._][A-Za-z0-9._/\- ]*", rel):
            raise HarnessError(f"bad --seed-state {spec[:60]!r}: expected '<json-or-source-file>:<relative/path>' "
                               "(the part after the LAST colon is the relative path inside the test data dir)")
        dest = (d / rel).resolve()
        if d.resolve() not in dest.parents:
            raise HarnessError(f"seed target {rel!r} resolves outside the test data dir {d}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if src.lstrip().startswith(("{", "[")):
            dest.write_text(src)
        else:
            shutil.copy2(src, dest)
    return d


def remove_data_dir(bundle_id: str) -> bool:
    """Delete the test identifier's data dir, only if the harness created it."""
    d = data_dir(bundle_id)
    if (d / ".desktop-test-owned").exists():
        shutil.rmtree(d)
        return True
    return False


def launch_bg(target: str | os.PathLike, *, args: list[str] | None = None, env: dict | None = None,
              seed: list[str] | None = None, stderr_path: str | os.PathLike | None = None,
              boot: float = 15, allow_real_identifier: bool = False, allow_multiple: bool = False,
              wait_window_s: float | None = 15) -> App:
    """Launch without activating. `target` is an .app bundle (open -g -n) or a bare executable (Popen).

    Asserts: bundle id is a test identifier and not already running (allow_multiple=True for a second instance
    of YOUR test app); the new app is NOT frontmost
    afterwards (if it is, the previous frontmost app is restored and HarnessError is raised)."""
    target = Path(target).expanduser().resolve()
    assert_owned_executable(target)
    front_before = front_app()
    bundle_id = None
    stderr = Path(stderr_path) if stderr_path else private_dir(prefix="dat-") / "stderr.log"
    stderr.parent.mkdir(parents=True, exist_ok=True)
    if stderr.is_symlink():
        raise HarnessError(f"refusing a symlinked stderr path: {stderr}")
    stderr.touch()
    if target.suffix == ".app":
        info = _bundle_info(target)
        bundle_id = info.get("CFBundleIdentifier")
        if not allow_real_identifier and not TEST_ID.search(bundle_id or ""):
            raise HarnessError(f"bundle id {bundle_id!r} is not a test identifier (must end in .test/.e2e/.probe/.bridge/.refusal-check); "
                               "build the app with a --config identifier overlay")
        if running_with_bundle(bundle_id) and not allow_multiple:
            raise HarnessError(f"{bundle_id} is already running (pids {running_with_bundle(bundle_id)}); refusing")
    if seed:
        if not bundle_id:
            raise HarnessError("--seed-state needs an .app bundle (the data dir is keyed by its identifier)")
        seed_state(bundle_id, seed)
    popen = None
    if target.suffix == ".app":
        exe = _bundle_exec(target)
        before = _pids_exec(exe)
        cmd = ["open", "-g", "-n", "--stderr", str(stderr)]
        for k, v in (env or {}).items():
            cmd += ["--env", f"{k}={v}"]
        cmd.append(str(target))
        if args:
            cmd += ["--args", *args]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise HarnessError(f"open failed: {r.stderr.strip()}")
        end, new = time.time() + boot, set()
        while time.time() < end and not new:
            time.sleep(0.1)
            new = _pids_exec(exe) - before
        if not new:
            raise HarnessError(f"no new {exe.name} process under {target} after {boot}s")
        pid = min(new)   # the parent, if the app forked a copy of itself
    else:
        fh = open(stderr, "ab")
        popen = subprocess.Popen([str(target), *(args or [])], stdout=subprocess.DEVNULL, stderr=fh,
                                 env={**os.environ, **(env or {})}, start_new_session=True)
        pid = popen.pid
    record_launch(pid, bundle_id)
    app = App(pid, bundle_id, stderr, target if target.suffix == ".app" else None, front_before, popen)
    # watch the front app while the app boots; a cold launch can flash to the front
    end, stole = time.time() + 2.0, False
    while time.time() < end:
        if app.front_is_me():
            stole = True
            break
        time.sleep(0.05)
    if stole:
        restore_front(front_before)
        raise HarnessError(f"pid {pid} became the frontmost app during launch (was {front_before.get('name')}); "
                           "restored the previous app")
    if wait_window_s:
        app.window(timeout=wait_window_s)
    return app


if __name__ == "__main__":
    print(json.dumps({"mode": focus_mode(), "idle": idle_seconds(), "front": front_app()}, indent=2))


# --------------------------------------------------------------------------- PNG sanity (stdlib only)

def png_stats(path: str | os.PathLike, crop: tuple[float, float, float, float] | None = None) -> dict:
    """Decode an 8-bit PNG (what screencapture/ScreenCaptureKit write) and say whether it holds real content.

    Returns width, height, distinct (number of distinct colors, sampled), dominant (share of the most common
    color) and blank (True when the image is one flat color or fully transparent).
    crop=(x0, y0, x1, y1) as fractions of the image restricts the check to a region: a window's chrome alone has
    many colors, so use it to ask "is there page content in the web area?" (a hidden WKWebView paints nothing)."""
    import struct
    import zlib
    data = Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise HarnessError(f"{path} is not a PNG")
    pos, idat, w = 8, b"", 0
    while pos < len(data):
        n, typ = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if typ == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", body[:10])
        elif typ == b"IDAT":
            idat += body
        pos += 12 + n
    bpp = {2: 3, 6: 4, 0: 1, 4: 2}.get(ctype)
    if depth != 8 or bpp is None:
        return {"width": w, "height": h, "note": f"unsupported png depth={depth} type={ctype}"}
    raw, stride = zlib.decompress(idat), w * bpp
    prev, rows, i = bytearray(stride), [], 0
    for _ in range(h):
        f, line, i = raw[i], bytearray(raw[i + 1:i + 1 + stride]), i + 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0
            b, c = prev[x], (prev[x - bpp] if x >= bpp else 0)
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + ((a + b) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        rows.append(line)
        prev = line
    from collections import Counter
    cnt = Counter()
    fx0, fy0, fx1, fy1 = crop or (0.0, 0.0, 1.0, 1.0)
    step = max(1, h // 120)
    for line in rows[int(h * fy0):max(int(h * fy1), int(h * fy0) + 1):step]:
        for x in range(int(w * fx0), max(int(w * fx1), int(w * fx0) + 1), 3):
            cnt[bytes(line[x * bpp:x * bpp + bpp])] += 1
    total = sum(cnt.values())
    top = cnt.most_common(1)[0]
    alpha0 = bpp == 4 and top[0][3] == 0 and top[1] / total > 0.99
    return {"width": w, "height": h, "distinct": len(cnt), "dominant": round(top[1] / total, 3),
            "blank": len(cnt) <= 2 or alpha0}
