"""desktop_test: stdlib-only helpers for testing a local macOS app without disturbing the user.

Pieces (see ../../desktop-app-testing.guide.md for when to use each):
  - focus policy      : focus_mode(), front_app(), restore_front()
  - swift tools       : tool("winlist", ...) compiles ../swift/<name>.swift on demand into a cache dir
  - windows / capture : windows(pid), main_window(pid), capture(window_id, out_png)
  - PID-targeted input: key(pid, ...), type_text(pid, ...), click(pid, ...), scroll(pid, ...)
  - AX                : ax_tree(pid), ax_press(pid, ...)
  - lifecycle         : launch_bg(...) -> App; App.quit()/App.kill() only ever touch PIDs this process started

Nothing here activates a window, moves the real cursor or posts HID-level events. The only HID-level
path is hid_click()/hid_key(), which refuse to run unless focus_mode() == "foreground".
"""
from __future__ import annotations

import hashlib
import json
import os
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent
SWIFT_DIR = HARNESS / "swift"
CACHE = Path(os.environ.get("DESKTOP_TEST_CACHE", "~/.cache/desktop-app-testing")).expanduser()
CONFIG = Path(os.environ.get("APP_TESTING_CONFIG", "~/.claude/app-testing.json")).expanduser()
DEFAULT_CONFIG = {"focus": "auto", "idleMinutes": 5}

# PIDs this process started. kill/quit refuse anything else.
_STARTED: set[int] = set()


class HarnessError(RuntimeError):
    pass


# --------------------------------------------------------------------------- focus policy

def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    try:
        cfg.update(json.loads(CONFIG.read_text()))
    except (OSError, ValueError):
        pass
    return cfg


def idle_seconds() -> float | None:
    """Seconds since the last HID input (keyboard/mouse), or None if it cannot be read."""
    try:
        out = subprocess.run(["ioreg", "-c", "IOHIDSystem"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', out)
    return int(m.group(1)) / 1e9 if m else None


def focus_mode() -> str:
    """'background' or 'foreground'. APP_TESTING_FOCUS overrides the config file. Unknown -> background."""
    mode = os.environ.get("APP_TESTING_FOCUS") or load_config().get("focus", "auto")
    if mode in ("background", "foreground"):
        return mode
    idle = idle_seconds()
    if idle is None:
        return "background"
    return "foreground" if idle >= float(load_config().get("idleMinutes", 5)) * 60 else "background"


def require_foreground(what: str) -> None:
    if focus_mode() != "foreground":
        raise HarnessError(f"{what}: needs the foreground and the user is active (not run, user active)")


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


# --------------------------------------------------------------------------- scratch / path guards

def scratch_roots() -> list[Path]:
    roots = [Path("/private/tmp"), Path(tempfile.gettempdir()).resolve()]
    extra = os.environ.get("DESKTOP_TEST_SCRATCH")
    if extra:
        roots += [Path(p).resolve() for p in extra.split(":") if p]
    return roots


def assert_scratch(path: str | os.PathLike) -> Path:
    """Refuse any path that is not inside a scratch root. Use before creating or seeding anything."""
    p = Path(path).expanduser().resolve()
    if not any(p == r or r in p.parents for r in scratch_roots()):
        raise HarnessError(f"{p} is not under a scratch root {[str(r) for r in scratch_roots()]}")
    return p


def scratch_copy(src: str | os.PathLike, dest: str | os.PathLike) -> Path:
    """Copy test data into scratch (symlinks kept as links). The source is only ever read."""
    dest = assert_scratch(dest)
    if dest.exists():
        subprocess.run(["chmod", "-R", "u+w", str(dest)], capture_output=True)
        shutil.rmtree(dest)
    shutil.copytree(src, dest, symlinks=True)
    return dest


TEST_ID = re.compile(r"(^|[.\-])(test|probe|e2e|dev)([.\-]|$)")


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

def tool(name: str, *args: str, check: bool = True, timeout: float = 30) -> subprocess.CompletedProcess:
    """Run swift/<name>.swift (compiled once into the cache dir, keyed by source hash)."""
    src = SWIFT_DIR / f"{name}.swift"
    digest = hashlib.sha256(src.read_bytes()).hexdigest()[:10]
    exe = CACHE / f"{name}-{digest}"
    if not exe.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        tmp = exe.with_suffix(f".tmp{os.getpid()}")
        r = subprocess.run(["swiftc", "-O", "-o", str(tmp), str(src)], capture_output=True, text=True)
        if r.returncode != 0:
            raise HarnessError(f"swiftc failed for {name}:\n{r.stderr}")
        os.replace(tmp, exe)
    r = subprocess.run([str(exe), *map(str, args)], capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise HarnessError(f"{name} {' '.join(map(str, args))} -> rc {r.returncode}: {r.stderr.strip()}")
    return r


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


def ax_press(pid: int, role: str, title: str) -> str:
    return tool("ax", pid, "press", role, title).stdout.strip()


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
        return not self.alive()

    kill = quit

    def _guard(self) -> None:
        if self.pid not in _STARTED:
            raise HarnessError(f"refusing to signal pid {self.pid}: not started by this harness")


def kill_pid(pid: int) -> None:
    """Signal a PID only if this process started it."""
    if pid not in _STARTED:
        raise HarnessError(f"refusing to signal pid {pid}: not started by this harness")
    os.kill(pid, signal.SIGTERM)


def _bundle_info(app: Path) -> dict:
    try:
        return plistlib.loads((app / "Contents/Info.plist").read_bytes())
    except (OSError, ValueError) as e:
        raise HarnessError(f"{app}: cannot read Info.plist ({e})")


def _pids_under(app: Path) -> set[int]:
    out = subprocess.run(["pgrep", "-f", str(app / "Contents/MacOS") + "/"], capture_output=True, text=True).stdout
    return {int(p) for p in out.split()}


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
        src, _, rel = spec.rpartition(":")
        dest = (d / rel).resolve()
        if not rel or d.resolve() not in dest.parents:
            raise HarnessError(f"seed target {rel!r} escapes {d}")
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
    front_before = front_app()
    bundle_id = None
    stderr = Path(stderr_path) if stderr_path else Path(tempfile.mkdtemp(prefix="dat-")) / "stderr.log"
    stderr.parent.mkdir(parents=True, exist_ok=True)
    stderr.touch()
    if target.suffix == ".app":
        info = _bundle_info(target)
        bundle_id = info.get("CFBundleIdentifier")
        if not allow_real_identifier and not TEST_ID.search(bundle_id or ""):
            raise HarnessError(f"bundle id {bundle_id!r} is not a test identifier (…test/probe/e2e/dev); "
                               "build the app with a --config identifier overlay")
        if running_with_bundle(bundle_id) and not allow_multiple:
            raise HarnessError(f"{bundle_id} is already running (pids {running_with_bundle(bundle_id)}); refusing")
    if seed:
        if not bundle_id:
            raise HarnessError("--seed-state needs an .app bundle (the data dir is keyed by its identifier)")
        seed_state(bundle_id, seed)
    popen = None
    if target.suffix == ".app":
        before = _pids_under(target)
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
            new = _pids_under(target) - before
        if not new:
            raise HarnessError(f"no new process under {target} after {boot}s")
        pid = max(new)
    else:
        fh = open(stderr, "ab")
        popen = subprocess.Popen([str(target), *(args or [])], stdout=subprocess.DEVNULL, stderr=fh,
                                 env={**os.environ, **(env or {})}, start_new_session=True)
        pid = popen.pid
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
