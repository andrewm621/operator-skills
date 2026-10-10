"""Static tests for the harness safety logic. No GUI app is launched and no event is posted.

    python3 -m unittest discover -s skills/test-desktop-app/harness/tests -v
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HARNESS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HARNESS / "lib"))
import desktop_test as dt  # noqa: E402


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="dat-test-"))
        self.addCleanup(subprocess.run, ["rm", "-rf", str(self.tmp)])
        self.cache = self.tmp / "cache"
        patcher = mock.patch.object(dt, "CACHE", self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)


class FocusMode(Tmp):
    """focus_mode() must fail safe: only exact values mean anything, every failure is background."""

    def run_mode(self, config=None, raw=None, env=None, idle=1000.0, blocked=False, front=None):
        cfg = self.tmp / "app-testing.json"
        if raw is not None:
            cfg.write_text(raw)
        elif config is not None:
            cfg.write_text(json.dumps(config))
        env_patch = {"APP_TESTING_FOCUS": env} if env is not None else {}
        with mock.patch.object(dt, "CONFIG", cfg), mock.patch.dict(os.environ, env_patch), \
                mock.patch.object(dt, "idle_seconds", return_value=idle), \
                mock.patch.object(dt, "session_blocked", return_value=blocked):
            os.environ.pop("APP_TESTING_FOCUS", None) if env is None else None
            return dt.focus_mode()

    def test_auto_idle_enough_is_foreground(self):
        self.assertEqual(self.run_mode({"focus": "auto", "idleMinutes": 5}, idle=301), "foreground")

    def test_auto_not_idle_is_background(self):
        self.assertEqual(self.run_mode({"focus": "auto", "idleMinutes": 5}, idle=299), "background")

    def test_exact_modes(self):
        self.assertEqual(self.run_mode({"focus": "foreground"}), "foreground")
        self.assertEqual(self.run_mode({"focus": "background"}, idle=99999), "background")

    def test_wrong_case_typo_and_non_strings_are_background(self):
        for bad in ("Foreground", "FOREGROUND", "forground", "Auto", " auto", "", None, 1, True, ["foreground"], {"a": 1}):
            with self.subTest(focus=bad):
                self.assertEqual(self.run_mode({"focus": bad}, idle=99999), "background")

    def test_missing_config_uses_defaults(self):
        with mock.patch.object(dt, "CONFIG", self.tmp / "nope.json"), \
                mock.patch.object(dt, "idle_seconds", return_value=1000.0), \
                mock.patch.object(dt, "session_blocked", return_value=False), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("APP_TESTING_FOCUS", None)
            self.assertEqual(dt.focus_mode(), "foreground")

    def test_bad_idle_minutes_is_background(self):
        for bad in ("5", None, -1, True, False, [5], {"m": 5}, float("nan"), float("inf")):
            with self.subTest(idleMinutes=bad):
                cfg = self.tmp / "app-testing.json"
                cfg.write_text(json.dumps({"focus": "auto", "idleMinutes": bad}))  # NaN/Infinity round-trip in python json
                with mock.patch.object(dt, "CONFIG", cfg), mock.patch.object(dt, "idle_seconds", return_value=99999.0), \
                        mock.patch.object(dt, "session_blocked", return_value=False):
                    os.environ.pop("APP_TESTING_FOCUS", None)
                    self.assertEqual(dt.focus_mode(), "background")

    def test_config_not_an_object_or_not_json_is_background(self):
        for raw in ('["foreground"]', '"foreground"', "42", "null", "{not json", ""):
            with self.subTest(raw=raw):
                self.assertEqual(self.run_mode(raw=raw, idle=99999), "background")

    def test_env_override(self):
        self.assertEqual(self.run_mode({"focus": "foreground"}, env="background"), "background")
        self.assertEqual(self.run_mode({"focus": "background"}, env="foreground"), "foreground")
        self.assertEqual(self.run_mode({"focus": "foreground"}, env="Background"), "background")  # bad env value: safe

    def test_locked_screen_or_loginwindow_is_background_in_every_mode(self):
        for focus in ("foreground", "auto"):
            with self.subTest(focus=focus):
                self.assertEqual(self.run_mode({"focus": focus}, idle=99999, blocked=True), "background")

    def test_any_exception_is_background(self):
        cfg = self.tmp / "c.json"
        cfg.write_text(json.dumps({"focus": "auto"}))
        for patch in (mock.patch.object(dt, "idle_seconds", side_effect=TypeError("boom")),
                      mock.patch.object(dt, "session_blocked", side_effect=RuntimeError("no swiftc")),
                      mock.patch.object(dt, "load_config", side_effect=ValueError("x"))):
            with self.subTest(patch=str(patch)), mock.patch.object(dt, "CONFIG", cfg), patch:
                os.environ.pop("APP_TESTING_FOCUS", None)
                self.assertEqual(dt.focus_mode(), "background")

    def test_idle_unreadable_is_background(self):
        self.assertEqual(self.run_mode({"focus": "auto"}, idle=None), "background")

    def test_session_blocked_logic(self):
        fake = lambda **kw: subprocess.CompletedProcess([], 0, stdout=json.dumps(kw), stderr="")
        front_ok = {"bundle": "com.apple.finder", "name": "Finder", "pid": 1}
        cases = [({"present": True, "locked": False, "onConsole": True}, front_ok, False),
                 ({"present": True, "locked": True, "onConsole": True}, front_ok, True),
                 ({"present": False, "locked": False, "onConsole": True}, front_ok, True),
                 ({"present": True, "locked": False, "onConsole": False}, front_ok, True),
                 ({"present": True, "locked": False, "onConsole": True},
                  {"bundle": "com.apple.loginwindow", "name": "loginwindow", "pid": 412}, True)]
        for sess, front, want in cases:
            with self.subTest(sess=sess, front=front["name"]), mock.patch.object(dt, "tool", return_value=fake(**sess)), \
                    mock.patch.object(dt, "front_app", return_value=front):
                self.assertEqual(dt.session_blocked(), want)


class GuardEvaluate(unittest.TestCase):
    A, USER, APP = {"pid": 10, "bundle": "a"}, {"pid": 20, "bundle": "u"}, {"pid": 30, "bundle": "x.test"}

    def test_user_switch_with_watch_list_is_not_a_violation_and_not_restored(self):
        r = dt.guard_evaluate(self.A, [self.A, self.USER], pids=[30])
        self.assertTrue(r["changed"]); self.assertFalse(r["to_watched"]); self.assertFalse(r["restore"])

    def test_steal_still_in_front_is_restored(self):
        r = dt.guard_evaluate(self.A, [self.A, self.APP], pids=[30])
        self.assertTrue(r["to_watched"]); self.assertTrue(r["restore"]); self.assertTrue(r["attributed"])

    def test_transient_steal_is_caught_but_not_restored_if_it_left(self):
        r = dt.guard_evaluate(self.A, [self.A, self.APP, self.A], pids=[30])
        self.assertTrue(r["to_watched"]); self.assertFalse(r["restore"])

    def test_bundle_watch(self):
        r = dt.guard_evaluate(self.A, [self.APP], bundles=["x.test"])
        self.assertTrue(r["to_watched"]); self.assertTrue(r["restore"])

    def test_no_watch_list_never_restores(self):
        r = dt.guard_evaluate(self.A, [self.A, self.USER])
        self.assertTrue(r["changed"]); self.assertFalse(r["restore"]); self.assertIsNone(r["attributed"])

    def test_unchanged(self):
        r = dt.guard_evaluate(self.A, [self.A, self.A], pids=[30])
        self.assertFalse(r["changed"]); self.assertFalse(r["restore"])


class TestIdentifier(unittest.TestCase):
    def test_accepts_test_style_suffixes(self):
        for ok in ("co.andrewmiller.strata.test", "co.andrewmiller.desktop-probe", "co.x.app.e2e", "co.x.app.bridge",
                   "co.x.app.refusal-check", "co.x.app-test"):
            self.assertTrue(dt.TEST_ID.search(ok), ok)

    def test_rejects_real_apps(self):
        for bad in ("dev.zed.Zed", "com.test.realapp", "com.apple.Safari", "co.x.testing", "co.x.test.app",
                    "co.x.contest", "co.andrewmiller.strata", "com.example.developer", ""):
            self.assertFalse(dt.TEST_ID.search(bad), bad)


class ToolGates(Tmp):
    def fake_run(self, calls):
        def run(cmd, **kw):
            calls.append((cmd, kw.get("env")))
            if cmd[0] == "swiftc":
                Path(cmd[cmd.index("-o") + 1]).write_text("#!/bin/sh\n")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return run

    def test_unknown_tool_refused(self):
        for n in ("rm", "../x", "nope", "hid click", ""):
            with self.assertRaises(dt.HarnessError):
                dt.tool(n)

    def test_hidclick_refused_in_background_however_spelled(self):
        calls = []
        with mock.patch.object(dt, "focus_mode", return_value="background"), \
                mock.patch.object(dt.subprocess, "run", self.fake_run(calls)):
            for n in ("hidclick", "HIDCLICK", "HidClick", "./hidclick", "/x/y/HIDCLICK"):
                with self.subTest(name=n), self.assertRaises(dt.HarnessError):
                    dt.tool(n, 1, 1)
            with self.assertRaises(dt.HarnessError):
                dt.hid_click(1, 1)
        self.assertEqual(calls, [])

    def test_hidclick_in_foreground_gets_a_one_shot_token(self):
        calls = []
        with mock.patch.object(dt, "focus_mode", return_value="foreground"), \
                mock.patch.object(dt.subprocess, "run", self.fake_run(calls)):
            dt.tool("HIDCLICK", 1, 1)
        env = calls[-1][1]
        pid, ts = env["DESKTOP_TEST_HID_OK"].split(":")
        self.assertEqual(int(pid), os.getpid())

    def test_hidclick_binary_refuses_without_a_valid_token(self):
        """Only REFUSING cases run. Never put this process's own pid in a token: the child's parent is this process,
        so that token is VALID and the binary would post a real click (it did once, at 1,1, while writing this test)."""
        exe = self.tmp / "hidclick"
        subprocess.run(["swiftc", "-O", "-o", str(exe), str(HARNESS / "swift/hidclick.swift")], check=True, capture_output=True)
        for env in ({}, {"DESKTOP_TEST_HID_OK": "1:1"}, {"DESKTOP_TEST_HID_OK": "garbage"},
                    {"DESKTOP_TEST_HID_OK": f"1:{int(__import__('time').time())}"},          # fresh, but names pid 1
                    {"DESKTOP_TEST_HID_OK": f"{os.getppid()}:{int(__import__('time').time())}"}):  # fresh, wrong parent
            r = subprocess.run([str(exe), "1", "1"], env={**{k: v for k, v in os.environ.items() if k != "DESKTOP_TEST_HID_OK"}, **env},
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 3, env)
            self.assertIn("refused", r.stderr)

    def test_input_tools_refuse_unrecorded_pids(self):
        calls = []
        with mock.patch.object(dt.subprocess, "run", self.fake_run(calls)):
            for args in (("pkey", os.getpid(), "type", "x"), ("PCLICK", os.getpid(), 1, 1, 0, 1), ("pscroll", os.getpid(), 1, 1, 5),
                         ("ax", os.getpid(), "press", "AXButton", "Save"), ("ax", os.getpid(), "set", "AXMinimized", "true"),
                         ("ax", os.getpid(), "enable")):
                with self.subTest(args=args), self.assertRaises(dt.HarnessError):
                    dt.tool(*args)
        self.assertEqual(calls, [])

    def test_read_only_tools_do_not_need_a_record(self):
        calls = []
        with mock.patch.object(dt.subprocess, "run", self.fake_run(calls)):
            dt.tool("winlist", 1)
            dt.tool("ax", 1, "tree", 3)
        self.assertTrue(calls)


class OwnPid(Tmp):
    def test_record_roundtrip_and_mismatches(self):
        pid = os.getpid()
        dt.record_launch(pid, "co.x.app.test")
        self.assertEqual(dt.assert_own_pid(pid)["pid"], pid)
        path = self.cache / "launches" / f"{pid}.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        rec = json.loads(path.read_text())
        for field, val in (("start_time", "Mon Jan  1 00:00:00 2001"), ("comm", "/bin/other")):
            path.write_text(json.dumps({**rec, field: val}))
            with self.subTest(field=field), self.assertRaises(dt.HarnessError):
                dt.assert_own_pid(pid)
        path.write_text(json.dumps(rec))
        with mock.patch.object(dt, "_live_bundle", return_value="com.apple.finder"), self.assertRaises(dt.HarnessError):
            dt.assert_own_pid(pid)

    def test_no_record_is_refused_and_stop_cannot_kill_it(self):
        with self.assertRaises(dt.HarnessError):
            dt.assert_own_pid(1)
        with self.assertRaises(dt.HarnessError):
            dt.kill_pid(os.getppid())


class OwnedExecutable(Tmp):
    def make_app(self, root: Path, name="T.app"):
        app = root / name
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/Frameworks").mkdir()
        (app / "Contents/MacOS/t").write_text("#!/bin/sh\n")
        for d in (app, app / "Contents", app / "Contents/MacOS", app / "Contents/Frameworks"):
            d.chmod(0o755)
        (app / "Contents/MacOS/t").chmod(0o755)
        return app

    def test_clean_bundle_passes(self):
        dt.assert_owned_executable(self.make_app(self.tmp))

    def test_writable_pieces_are_refused(self):
        for rel, mode in (("Contents/MacOS/t", 0o775), ("Contents/MacOS", 0o777), ("Contents/Frameworks", 0o775),
                          ("Contents", 0o757), (".", 0o770)):
            with self.subTest(rel=rel, mode=oct(mode)):
                app = self.make_app(self.tmp, f"A{mode}{abs(hash(rel))}.app")
                (app / rel).chmod(mode)
                with self.assertRaises(dt.HarnessError):
                    dt.assert_owned_executable(app)

    def test_frameworks_entry_and_symlink_targets(self):
        app = self.make_app(self.tmp, "F.app")
        fw = app / "Contents/Frameworks/X.framework"
        fw.mkdir(); fw.chmod(0o777)
        with self.assertRaises(dt.HarnessError):
            dt.assert_owned_executable(app)
        app2 = self.make_app(self.tmp, "L.app")
        evil = self.tmp / "evil"; evil.write_text("x"); evil.chmod(0o666)
        os.symlink(evil, app2 / "Contents/MacOS/link")
        with self.assertRaises(dt.HarnessError):
            dt.assert_owned_executable(app2)

    def test_world_writable_parent_refused_unless_sticky(self):
        loose = self.tmp / "loose"; loose.mkdir(); loose.chmod(0o777)
        with self.assertRaises(dt.HarnessError):
            dt.assert_owned_executable(self.make_app(loose))
        sticky = self.tmp / "sticky"; sticky.mkdir(); sticky.chmod(0o1777)
        dt.assert_owned_executable(self.make_app(sticky))

    def test_system_app_passes(self):
        app = Path("/System/Applications/Calculator.app")
        if app.exists():
            dt.assert_owned_executable(app)


class SeedAndScratch(Tmp):
    def test_bad_seed_specs_have_a_clear_message(self):
        with mock.patch.object(dt, "data_dir", return_value=self.tmp / "data"):
            for spec in ('{"a":1}', "nocolon", ":state.json", '{"a":1}:../x', '{"a":1}:/abs', "x:"):
                with self.subTest(spec=spec), self.assertRaises(dt.HarnessError) as cm:
                    dt.seed_state("co.x.test", [spec])
                self.assertTrue(("seed" in str(cm.exception)) or ("escapes" in str(cm.exception)), str(cm.exception))
            dt.seed_state("co.x.test", ['{"last_folder":"/p"}:state.json'])
            self.assertEqual((self.tmp / "data/state.json").read_text(), '{"last_folder":"/p"}')

    def test_assert_scratch_and_private_dir(self):
        with self.assertRaises(dt.HarnessError):
            dt.assert_scratch(Path.home() / "knowledge/x")
        with self.assertRaises(dt.HarnessError):
            dt.assert_private_dir("/private/tmp")
        d = dt.private_dir(prefix="dat-test-")
        self.addCleanup(os.rmdir, d)
        self.assertEqual(stat.S_IMODE(d.stat().st_mode), 0o700)


class AxRefusals(Tmp):
    """The Swift `ax` tool refuses disallowed attributes before it touches any process."""

    def test_attribute_allow_list(self):
        exe = self.tmp / "ax"
        subprocess.run(["swiftc", "-O", "-o", str(exe), str(HARNESS / "swift/ax.swift")], check=True, capture_output=True)
        pid = str(os.getpid())  # our own python process: nothing is ever set on it, the tool refuses first
        for args in (["set", "AXFrontmost", "true"], ["set", "AXFocused", "true"], ["set", "AXMinimized", "maybe"],
                     ["enable", "AXFrontmost"], ["enable", "AXMinimized"]):
            r = subprocess.run([str(exe), pid, *args], capture_output=True, text=True)
            self.assertIn(r.returncode, (2, 3), args)   # 2 = refused, 3 = no Accessibility for this process (also safe)
            self.assertNotIn("set ", r.stdout)


if __name__ == "__main__":
    unittest.main()
