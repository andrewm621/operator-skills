"""Tests for verify.py. Stdlib only; synthetic bundles in a temp dir, never real exports.

Run:  python3 -I -m unittest discover -s skills/ai-export -p 'test_verify.py'
"""
import copy
import gzip
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
VERIFY = os.path.join(HERE, "verify.py")
CONVERT = os.path.join(HERE, "convert.py")
PROJECT = "g-p-" + "a1b2c3d4" * 4
CID = "11111111-1111-1111-1111-111111111111"
CID2 = "22222222-2222-2222-2222-222222222222"


def msg(role, content, t, recipient=None, name=None, meta=None):
    m = {"author": {"role": role}, "content": content, "create_time": t, "metadata": meta or {}}
    if name:
        m["author"]["name"] = name
    if recipient:
        m["recipient"] = recipient
    return m


def text(s):
    return {"content_type": "text", "parts": [s]}


def conv(cid=CID, extra=None):
    mp = {
        "root": {"id": "root", "parent": None, "children": ["u1"], "message": None},
        "u1": {"id": "u1", "parent": "root", "children": ["th"], "message": msg("user", text("hello"), 1760000000)},
        "th": {"id": "th", "parent": "u1", "children": ["call"], "message": msg(
            "assistant", {"content_type": "thoughts", "thoughts": [{"summary": "s", "content": "secret plan"}]}, 1760000001)},
        "call": {"id": "call", "parent": "th", "children": ["res"], "message": msg(
            "assistant", {"content_type": "code", "text": '{"q": 1}', "language": "json"}, 1760000002, recipient="api_tool.call_tool")},
        "res": {"id": "res", "parent": "call", "children": ["a1"], "message": msg(
            "tool", {"content_type": "text", "parts": [""]}, 1760000003, name="api_tool.call_tool")},
        "a1": {"id": "a1", "parent": "res", "children": [], "message": msg(
            "assistant", text("answer"), 1760000004, meta={"canvas": {"textdoc_id": "td1", "title": "Doc"}})},
    }
    c = {"conversation_id": cid, "title": "T", "create_time": 1760000000, "update_time": 1760000004,
         "mapping": mp, "current_node": "a1"}
    if extra:
        extra(c)
    return c


def bundle(convs=None, **kw):
    convs = [conv()] if convs is None else convs
    b = {"platform": "chatgpt", "kind": "project", "project": PROJECT, "pulled_at": "2026-11-08T00:00:00Z",
         "started_at": "2026-11-07T23:59:00Z", "since": None, "partial": False, "stop_reason": "complete",
         "listing": [{"id": c["conversation_id"], "title": "T", "create_time": "2025-10-09T00:00:00Z",
                      "update_time": "2025-10-09T08:53:24Z", "triage": None} for c in convs],
         "attachments": [], "errors": [], "conversations": convs}
    b.update(kw)
    return b


class VerifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def run_verify(self, b, *extra, cmd="check", gz=False):
        path = os.path.join(self.dir, "b.json.gz" if gz else "b.json")
        data = json.dumps(b).encode()
        with (gzip.open(path, "wb") if gz else open(path, "wb")) as f:
            f.write(data)
        argv = [sys.executable, "-I", VERIFY, cmd, "--input", path] + list(extra)
        if cmd == "check":
            argv.append("--json")
        p = subprocess.run(argv, capture_output=True, text=True)
        out = json.loads(p.stdout) if cmd == "check" and p.stdout.strip().startswith("{") else p.stdout
        return p.returncode, out, p.stderr

    def fails(self, out):
        return [f["msg"] for f in out["findings"] if f["level"] == "FAIL"]

    def test_clean_bundle_passes_and_names_gaps(self):
        code, out, err = self.run_verify(bundle(), "--expected-count", "1", gz=True)
        self.assertEqual(code, 0, err)
        th = out["threads"][0]
        self.assertEqual(th["rendered"], th["expected_render"])
        self.assertEqual(th["rendered"], 3)  # user, tool call, answer
        self.assertIn("hidden reasoning", th["labels"]["policy"])
        self.assertIn("empty tool output (api_tool.call_tool)", th["labels"]["empty"])
        self.assertEqual([c["id"] for c in th["external"]["canvas"]], ["td1"])
        warns = [f["msg"] for f in out["findings"] if f["level"] == "WARN"]
        self.assertTrue(any("canvas doc" in w for w in warns), warns)

    def test_partial_and_stop_reason_fail(self):
        code, out, _ = self.run_verify(bundle(partial=True, stop_reason="stuck_cursor"))
        self.assertEqual(code, 1)
        self.assertTrue(any("partial" in m for m in self.fails(out)))
        self.assertTrue(any("stuck_cursor" in m for m in self.fails(out)))

    def test_expected_count_mismatch_fails(self):
        code, out, _ = self.run_verify(bundle(), "--expected-count", "2")
        self.assertEqual(code, 1)
        self.assertTrue(any("project page shows 2" in m for m in self.fails(out)))

    def test_missing_fetch_and_errors_fail(self):
        b = bundle([conv(), conv(CID2)])
        b["conversations"] = b["conversations"][:1]
        b["errors"] = [{"id": CID2, "status": 500}]
        code, out, _ = self.run_verify(b)
        self.assertEqual(code, 1)
        msgs = self.fails(out)
        self.assertTrue(any("not fetched" in m and CID2 in m for m in msgs), msgs)
        self.assertTrue(any("fetch error" in m for m in msgs), msgs)

    def test_unchanged_rows_are_not_expected(self):
        b = bundle([conv(), conv(CID2)], since="2026-01-01T00:00:00Z", fetch_unchanged=False)
        b["listing"][1]["triage"] = "unchanged"
        b["listing"][0]["triage"] = "grown"
        b["conversations"] = b["conversations"][:1]
        code, out, err = self.run_verify(b)
        self.assertEqual(code, 0, out["findings"])

    def test_unreachable_node_and_bad_current_fail(self):
        def broken(c):
            c["mapping"]["orphan"] = {"id": "orphan", "parent": "nowhere-but-also-root", "children": [], "message": None}
            c["mapping"]["u1"]["children"].append("ghost")
        code, out, _ = self.run_verify(bundle([conv(extra=broken)]))
        self.assertEqual(code, 1)
        msgs = self.fails(out)
        self.assertTrue(any("roots" in m for m in msgs), msgs)
        self.assertTrue(any("missing from the mapping" in m for m in msgs), msgs)

    def test_unknown_content_type_and_dropped_part_fail(self):
        def odd(c):
            c["mapping"]["a1"]["message"]["content"] = {"content_type": "brand_new_widget", "text": "x"}
            c["mapping"]["u1"]["message"]["content"] = {"content_type": "multimodal_text", "parts": [
                "hi", {"content_type": "some_new_part", "text": "spoken"}]}
        code, out, _ = self.run_verify(bundle([conv(extra=odd)]))
        self.assertEqual(code, 1)
        msgs = self.fails(out)
        self.assertTrue(any("brand_new_widget" in m for m in msgs), msgs)
        self.assertTrue(any("some_new_part" in m for m in msgs), msgs)

    def test_voice_turns_render_and_audio_pointers_are_outside_objects_not_drops(self):
        def voice(c):
            c["mapping"]["u1"]["message"]["content"] = {"content_type": "multimodal_text", "parts": [
                {"content_type": "audio_transcription", "text": "spoken words", "direction": "in", "decoding_id": None},
                {"content_type": "audio_asset_pointer", "asset_pointer": "file-service://file-aud1", "size_bytes": 5},
                {"content_type": "real_time_user_audio_video_asset_pointer", "audio_asset_pointer": {"asset_pointer": "sediment://x"}}]}
            c["mapping"]["a1"]["message"]["content"] = {"content_type": "multimodal_text", "parts": [
                {"content_type": "audio_transcription", "text": "spoken reply", "direction": "out", "decoding_id": None}]}
        code, out, err = self.run_verify(bundle([conv(extra=voice)]))
        self.assertEqual(code, 0, (err, self.fails(out)))
        th = out["threads"][0]
        self.assertEqual(th["rendered"], th["expected_render"])
        self.assertEqual(out["totals"]["lost"], 0)
        self.assertIn("audio", th["external"])

    def test_voice_turn_with_no_text_is_still_a_lost_message(self):
        def voice(c):
            c["mapping"]["a1"]["message"]["content"] = {"content_type": "multimodal_text", "parts": [
                {"content_type": "audio_transcription", "text": None}]}
        code, out, _ = self.run_verify(bundle([conv(extra=voice)]))
        self.assertEqual(code, 1)
        self.assertTrue(any("should have rendered" in m for m in self.fails(out)), self.fails(out))

    def test_long_off_path_branch_renders_whole(self):
        def long_branch(c):
            mp = c["mapping"]
            mp["u1"]["children"].append("b0")
            for i in range(700):
                mp["b%d" % i] = {"id": "b%d" % i, "parent": "b%d" % (i - 1) if i else "u1",
                                 "children": ["b%d" % (i + 1)] if i < 699 else [],
                                 "message": msg("assistant", text("alt %d" % i), 1760000100 + i)}
        code, out, err = self.run_verify(bundle([conv(extra=long_branch)]))
        self.assertEqual(code, 0, (err, self.fails(out)))
        self.assertEqual(out["totals"]["lost"], 0)

    def test_lost_message_fails(self):
        # an assistant message with only a non-string, non-image part renders nothing in convert.py
        def lost(c):
            c["mapping"]["a1"]["message"]["content"] = {"content_type": "multimodal_text", "parts": [{"content_type": "x"}]}
        code, out, _ = self.run_verify(bundle([conv(extra=lost)]))
        self.assertEqual(code, 1)
        self.assertTrue(any("should have rendered" in m for m in self.fails(out)), self.fails(out))

    def test_redaction_stub_is_named_not_failed(self):
        def red(c):
            c["mapping"]["call"]["message"]["content"] = text("The output of this plugin was redacted.")
        code, out, _ = self.run_verify(bundle([conv(extra=red)]))
        self.assertEqual(code, 0, out["findings"])
        self.assertTrue(any("redacted" in f["msg"] for f in out["findings"] if f["level"] == "INFO"))

    def test_textdocs_fetched_clear_the_warning(self):
        b = bundle(textdocs={"td1": {"id": "td1", "content": "c"}}, textdoc_errors=[])
        code, out, _ = self.run_verify(b)
        self.assertEqual(code, 0)
        self.assertFalse(any("canvas" in f["msg"] for f in out["findings"] if f["level"] in ("WARN", "FAIL")))

    def test_notes_cross_check(self):
        b = bundle()
        bpath = os.path.join(self.dir, "in.json")
        with open(bpath, "w") as f:
            json.dump(b, f)
        out_dir = os.path.join(self.dir, "out")
        subprocess.run([sys.executable, "-I", CONVERT, "--input", bpath, "--out-dir", out_dir, "--date", "2026-11-08"],
                       check=True, capture_output=True)
        code, out, _ = self.run_verify(b, "--notes-dir", out_dir)
        self.assertEqual(code, 0, out["findings"])
        note = [n for n in os.listdir(out_dir) if not n.endswith("-index.md")][0]
        path = os.path.join(out_dir, note)
        with open(path) as f:
            body = f.read()
        with open(path, "w") as f:
            f.write(body.replace("## Assistant ·", "## Removed ·", 1))
        code, out, _ = self.run_verify(b, "--notes-dir", out_dir)
        self.assertEqual(code, 1)
        self.assertTrue(any("rendered blocks" in m for m in self.fails(out)))

    def test_report_md_written_once(self):
        rpath = os.path.join(self.dir, "r", "report.md")
        code, _, _ = self.run_verify(bundle(), "--report-md", rpath)
        self.assertEqual(code, 0)
        with open(rpath) as f:
            self.assertIn("Verdict: PASS", f.read())
        code, _, err = self.run_verify(bundle(), "--report-md", rpath)
        self.assertNotEqual(code, 0)  # never overwrites

    def test_spot_check_live_comparison(self):
        b = bundle()
        live = os.path.join(self.dir, "live.json")
        with open(live, "w") as f:
            json.dump({"id": CID, "update_time": 1760000004, "current_node": "a1", "nodes": 6,
                       "last_message_time": 1760000004}, f)
        code, out, _ = self.run_verify(b, "--thread", CID, "--live", live, cmd="spot")
        self.assertEqual(code, 0, out)
        with open(live, "w") as f:
            json.dump({"id": CID, "update_time": 1770000000, "current_node": "zz", "nodes": 9}, f)
        code, out, _ = self.run_verify(b, "--thread", CID, "--live", live, cmd="spot")
        self.assertEqual(code, 1)
        self.assertIn("grown since the pull", out)

    def test_since_prefers_newest_complete_started_at(self):
        arch = os.path.join(self.dir, "raw")
        os.mkdir(arch)
        for name, b in (("a.json.gz", bundle(started_at="2026-11-01T00:00:00Z")),
                        ("b.json.gz", bundle(started_at="2026-11-07T00:00:00Z")),
                        ("c.json.gz", bundle(started_at="2026-11-09T00:00:00Z", partial=True)),
                        ("d.json.gz", bundle(started_at="2026-11-10T00:00:00Z", project="g-p-" + "f" * 32))):
            with gzip.open(os.path.join(arch, name), "wb") as f:
                f.write(json.dumps(b).encode())
        p = subprocess.run([sys.executable, "-I", VERIFY, "since", "--archive-dir", arch, "--project", PROJECT],
                           capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.strip(), "2026-11-07T00:00:00Z")

    def test_since_from_index_note(self):
        note = os.path.join(self.dir, "idx.md")
        with open(note, "w") as f:
            f.write("---\ntype: source\n---\n\nPulled 2026-11-08T16:40:07.056Z from the ChatGPT web app via its own JSON API.\n")
        p = subprocess.run([sys.executable, "-I", VERIFY, "since", "--index-note", note], capture_output=True, text=True)
        self.assertEqual(p.stdout.strip(), "2026-11-08T16:40:07.056Z")
        with open(note, "a") as f:
            f.write("| Next --since cutoff | `2026-11-08T16:39:00Z` |\n")
        p = subprocess.run([sys.executable, "-I", VERIFY, "since", "--index-note", note], capture_output=True, text=True)
        self.assertEqual(p.stdout.strip(), "2026-11-08T16:39:00Z")


    def test_schema2_bundle_still_verifies(self):
        b = bundle(schema=2, listing_pages=1, list_only=False, fetch_unchanged=False)
        code, out, err = self.run_verify(b, "--expected-count", "1")
        self.assertEqual(code, 0, out["findings"])
        self.assertEqual(out["bundle"]["kind"], "project")


# ---------------------------------------------------------------- account pulls (schema-3 parts)

RUN = "20261110T120000Z-abc123"
RUN2 = "20261111T090000Z-def456"
RUN3 = "20261112T090000Z-0f0f0f"
P1 = "g-p-" + "b" * 32


def uid(n):
    return "00000000-0000-4000-8000-%012x" % n


def acc_sources(main="complete", archived="complete", projects="complete", pt=None):
    pt = {P1: {"name": "Proj", "stop_reason": "complete", "pages": 1, "count": 1}} if pt is None else pt
    return {"main": {"stop_reason": main, "pages": 1, "count": 3, "new": 3},
            "archived": {"stop_reason": archived, "pages": 1, "count": 1, "new": 1},
            "projects": {"stop_reason": projects, "pages": 1, "count": len(pt)}, "project_threads": pt}


def acc_row(n, **kw):
    r = {"id": uid(n), "title": "T%d" % n, "create_time": "2025-10-09T00:00:00Z", "update_time": "2025-10-09T08:53:24Z",
         "sources": ["main"], "project": None, "project_name": None, "triage": None}
    r.update(kw)
    return r


def acc_part(idx, final, ids, run=RUN, listing=None, **kw):
    convs = [conv(uid(n)) for n in ids]
    listing = [acc_row(n) for n in (1, 2, 3, 4)] if listing is None else listing
    b = {"platform": "chatgpt", "schema": 3, "kind": "account", "project": None, "run_id": run, "resume_of": None,
         "part": idx, "final": final, "started_at": "2026-11-10T12:00:00.000Z", "pulled_at": "2026-11-10T13:00:00.000Z",
         "since": None, "partial": False, "listing_complete": True, "stop_reason": "complete", "error": None,
         "capped": False, "remaining": 0 if final else None, "sources": acc_sources(), "listing_skipped": False,
         "listing_pages": 4, "list_only": False, "fetch_unchanged": False, "fetch_textdocs": False, "only_ids": None,
         "max_threads": None, "part_bytes": 100000000, "listing_count": len(listing), "to_fetch_count": len(listing),
         "ids": [c["conversation_id"] for c in convs], "listing": listing, "conversations": convs, "attachments": [], "errors": []}
    b.update(kw)
    return b


def resume_part(idx, final, ids, run=RUN2, of=RUN, only=None, **kw):
    return acc_part(idx, final, ids, run=run, listing=[], resume_of=of, sources=None, listing_skipped=True,
                    stop_reason="skipped", started_at="2026-11-11T09:00:00.000Z", only_ids=only or [uid(n) for n in ids], **kw)


def part_name(b):
    return "chatgpt-account-%s-part-%03d.json" % (b["run_id"], b["part"])


class AccountVerifyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.addCleanup(self.tmp.cleanup)

    def write_parts(self, parts, sub="parts", gz=False, names=None):
        d = os.path.join(self.dir, sub)
        os.makedirs(d, exist_ok=True)
        paths = []
        for i, b in enumerate(parts):
            name = (names[i] if names else part_name(b)) + (".gz" if gz else "")
            path = os.path.join(d, name)
            data = json.dumps(b).encode()
            with (gzip.open(path, "wb") if gz else open(path, "wb")) as f:
                f.write(data)
            paths.append(path)
        return d, paths

    def check(self, inputs, *extra):
        argv = [sys.executable, "-I", VERIFY, "check", "--json"]
        for i in inputs:
            argv += ["--input", i]
        p = subprocess.run(argv + list(extra), capture_output=True, text=True)
        self.assertTrue(p.stdout.strip().startswith("{"), p.stderr)
        return p.returncode, json.loads(p.stdout)

    def fails(self, out, level="FAIL"):
        return [f["msg"] for f in out["findings"] if f["level"] == level]

    def three_parts(self):
        return [acc_part(0, False, [1, 2]), acc_part(1, False, [3]), acc_part(2, True, [4])]

    def test_clean_multi_part_pull_passes_by_dir_and_by_file(self):
        d, paths = self.write_parts(self.three_parts())
        code, out = self.check([d])
        self.assertEqual(code, 0, self.fails(out))
        self.assertEqual(out["bundle"]["kind"], "account")
        self.assertEqual((out["bundle"]["parts"], out["bundle"]["fetched"], out["bundle"]["missing"]), (3, 4, 0))
        code, out = self.check(list(reversed(paths)))
        self.assertEqual(code, 0, self.fails(out))
        self.assertEqual(len(out["threads"]), 4)

    def test_missing_duplicated_and_final_parts_fail(self):
        p = self.three_parts()
        d, paths = self.write_parts(p)
        code, out = self.check([paths[0], paths[2]])
        self.assertEqual(code, 1)
        self.assertTrue(any("part(s) 1 missing" in m for m in self.fails(out)), self.fails(out))
        self.assertTrue(any("in no part" in m and uid(3) in m for m in self.fails(out)), self.fails(out))
        code, out = self.check(paths + [paths[1]])
        self.assertTrue(any("part 1 given 2 times" in m for m in self.fails(out)), self.fails(out))
        code, out = self.check(paths[:2])
        self.assertTrue(any("no final part" in m for m in self.fails(out)), self.fails(out))

    def test_mismatched_run_ids_fail(self):
        a = self.three_parts()
        b = acc_part(0, True, [1, 2, 3, 4], run=RUN3)
        _, paths = self.write_parts(a + [b])
        code, out = self.check(paths)
        self.assertEqual(code, 1)
        self.assertTrue(any("mismatched run ids" in m and "separate pulls" in m for m in self.fails(out)), self.fails(out))
        r = resume_part(0, True, [4], of=RUN3)
        _, paths = self.write_parts([acc_part(0, True, [1, 2, 3]), r], sub="p2")
        code, out = self.check(paths)
        self.assertTrue(any("mismatched run ids" in m and "resumes" in m for m in self.fails(out)), self.fails(out))

    def test_file_name_must_match_header(self):
        b = acc_part(0, True, [1, 2, 3, 4])
        _, paths = self.write_parts([b], names=["chatgpt-account-%s-part-007.json" % RUN])
        code, out = self.check(paths)
        self.assertTrue(any("file name says" in m for m in self.fails(out)), self.fails(out))

    def test_every_listing_source_must_be_complete(self):
        for kw, needle in ((dict(main="ceiling"), "main"), (dict(archived="http_400"), "archived"),
                           (dict(projects="stuck_cursor"), "projects"),
                           (dict(pt={P1: {"stop_reason": "stuck_cursor", "count": 0}}), "project listing")):
            b = acc_part(0, True, [1, 2, 3, 4], sources=acc_sources(**kw), listing_complete=False, partial=True)
            _, paths = self.write_parts([b], sub="s-" + needle.replace(" ", "-"))
            code, out = self.check(paths)
            self.assertEqual(code, 1, kw)
            self.assertTrue(any(needle in m for m in self.fails(out)), (kw, self.fails(out)))

    def test_since_cutoff_accepted_only_for_incremental_pulls(self):
        listing = [acc_row(1, triage="new"), acc_row(2, triage="unchanged"), acc_row(3, triage="grown"), acc_row(4, triage="unchanged")]
        b = acc_part(0, True, [1, 3], listing=listing, since="2026-11-03T00:00:00Z", sources=acc_sources(main="since_cutoff"))
        _, paths = self.write_parts([b])
        code, out = self.check(paths)
        self.assertEqual(code, 0, self.fails(out))
        self.assertTrue(any("since cutoff" in m for m in self.fails(out, "INFO")))
        b["since"] = None
        _, paths = self.write_parts([b], sub="nosince")
        code, out = self.check(paths)
        self.assertEqual(code, 1)

    def test_ids_header_must_match_conversations(self):
        b = acc_part(0, True, [1, 2, 3, 4])
        b["ids"] = b["ids"][:3]
        _, paths = self.write_parts([b])
        code, out = self.check(paths)
        self.assertTrue(any("ids header" in m for m in self.fails(out)), self.fails(out))

    def test_resume_run_completes_a_broken_pull(self):
        # tab reloaded after part 0: the primary has no final part; a resume run fetched the rest
        prim = acc_part(0, False, [1, 2])
        _, paths = self.write_parts([prim, resume_part(0, True, [3, 4])])
        code, out = self.check(paths)
        self.assertEqual(code, 0, self.fails(out))
        self.assertTrue(any("no final part" in m for m in self.fails(out, "WARN")))
        self.assertEqual(out["bundle"]["resume_runs"], [RUN2])
        # an error in the primary is superseded by the resume run too; in the latest run it fails
        err = acc_part(0, True, [1, 2], error="rate limited (429) after retries", partial=True)
        _, paths = self.write_parts([err, resume_part(0, True, [3, 4])], sub="err")
        code, out = self.check(paths)
        self.assertEqual(code, 0, self.fails(out))
        code, out = self.check(paths[:1])
        self.assertTrue(any("ended in error" in m for m in self.fails(out)))

    def test_fetch_error_fails_until_resolved(self):
        b = acc_part(0, True, [1, 2, 4], errors=[{"id": uid(3), "status": 404}])
        _, paths = self.write_parts([b])
        code, out = self.check(paths)
        self.assertTrue(any("still in no part" in m and "404" in m for m in self.fails(out)), self.fails(out))
        _, more = self.write_parts([resume_part(0, True, [3])], sub="r")
        code, out = self.check(paths + more)
        self.assertEqual(code, 0, self.fails(out))

    def test_part_only_checks_one_part_alone(self):
        p = self.three_parts()
        _, paths = self.write_parts(p)
        code, out = self.check([paths[1]], "--part-only")
        self.assertEqual(code, 0, self.fails(out))
        code, out = self.check([paths[1]])
        self.assertEqual(code, 1)

    def test_capped_run_and_missing_subcommand(self):
        b = acc_part(0, True, [1], capped=True, remaining=3, max_threads=1)
        d, paths = self.write_parts([b])
        code, out = self.check(paths)
        self.assertEqual(code, 1)
        self.assertTrue(any("capped backfill" in m for m in self.fails(out)), self.fails(out))
        p = subprocess.run([sys.executable, "-I", VERIFY, "missing", "--input", d], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout), [uid(2), uid(3), uid(4)])
        self.assertIn("resumeOf = '%s'" % RUN, p.stderr)
        p = subprocess.run([sys.executable, "-I", VERIFY, "missing", "--input", d, "--limit", "2"], capture_output=True, text=True)
        self.assertEqual(json.loads(p.stdout), [uid(2), uid(3)])
        _, more = self.write_parts([resume_part(0, True, [2, 3, 4])])
        p = subprocess.run([sys.executable, "-I", VERIFY, "missing", "--input", d], capture_output=True, text=True)
        self.assertEqual(json.loads(p.stdout), [])
        self.assertIn("nothing missing", p.stderr)

    def test_time_capped_run_verifies_like_a_thread_capped_one(self):
        b = acc_part(0, True, [1], capped=True, capped_by="time", remaining=3, max_threads=None, max_minutes=1, to_fetch_count=4)
        d, paths = self.write_parts([b])
        code, out = self.check(paths)
        self.assertEqual(code, 1)
        self.assertTrue(any("capped backfill" in m and "expected while" in m for m in self.fails(out)), self.fails(out))
        p = subprocess.run([sys.executable, "-I", VERIFY, "missing", "--input", d], capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout), [uid(2), uid(3), uid(4)])
        self.assertIn("resumeOf = '%s'" % RUN, p.stderr)
        self.assertTrue(any("capped (by time)" in m for m in self.fails(out, "INFO")), self.fails(out, "INFO"))

    def test_rate_limited_run_prints_rate_limit_info_and_stays_a_fail(self):
        rl = {"at": "2026-11-10T03:00:00.000Z", "phase": "fetching", "done": 1, "retry_after_s": 90}
        b = acc_part(0, True, [1], partial=True, error="rate limited (429), not retried; retry-after 90s", remaining=3, rate_limit=rl)
        d, paths = self.write_parts([b])
        code, out = self.check(paths)
        self.assertEqual(code, 1)
        self.assertTrue(any("run ended in error" in m for m in self.fails(out)), self.fails(out))
        self.assertTrue(any("rate limited (429) during fetching after 1 fetch(es); retry-after 90 s" in m for m in self.fails(out, "INFO")), self.fails(out, "INFO"))
        rl["retry_after_s"] = None
        _, paths = self.write_parts([b], sub="p2")
        _, out = self.check(paths)
        self.assertTrue(any("retry-after not given" in m for m in self.fails(out, "INFO")), self.fails(out, "INFO"))
        p = subprocess.run([sys.executable, "-I", VERIFY, "missing", "--input", d], capture_output=True, text=True)
        self.assertEqual(len(json.loads(p.stdout)), b["remaining"], "remaining agrees with the ids verify.py missing prints")

    def test_notes_cross_check_for_an_account_pull(self):
        d, _ = self.write_parts(self.three_parts())
        out_dir = os.path.join(self.dir, "out")
        subprocess.run([sys.executable, "-I", CONVERT, "--input", d, "--out-dir", out_dir, "--date", "2026-11-10"],
                       check=True, capture_output=True)
        code, out = self.check([d], "--notes-dir", out_dir)
        self.assertEqual(code, 0, self.fails(out))
        self.assertTrue(all(t["note_blocks"] == t["rendered"] for t in out["threads"]))

    def test_since_account_finds_newest_complete_pull(self):
        arch = os.path.join(self.dir, "raw")
        old = [acc_part(0, True, [1, 2, 3, 4], run="20261101T000000Z-111111", started_at="2026-11-01T00:00:00.000Z")]
        new = [acc_part(0, True, [1, 2], run="20261108T000000Z-222222", started_at="2026-11-08T00:00:00.000Z")]
        self.write_parts(old + new, sub="raw", gz=True)
        with gzip.open(os.path.join(arch, "chatgpt-project-2026-11-09.json.gz"), "wb") as f:
            f.write(json.dumps(bundle(started_at="2026-11-09T00:00:00Z")).encode())
        run = lambda: subprocess.run([sys.executable, "-I", VERIFY, "since", "--archive-dir", arch, "--account"],
                                     capture_output=True, text=True)
        p = run()
        self.assertEqual((p.returncode, p.stdout.strip()), (0, "2026-11-01T00:00:00.000Z"), p.stderr)
        self.write_parts([resume_part(0, True, [3, 4], run="20261108T050000Z-333333", of="20261108T000000Z-222222")], sub="raw", gz=True)
        p = run()
        self.assertEqual(p.stdout.strip(), "2026-11-08T00:00:00.000Z", p.stderr)
        # the project form ignores account parts and still finds its own pull
        p = subprocess.run([sys.executable, "-I", VERIFY, "since", "--archive-dir", arch, "--project", PROJECT],
                           capture_output=True, text=True)
        self.assertEqual(p.stdout.strip(), "2026-11-09T00:00:00Z", p.stderr)


if __name__ == "__main__":
    unittest.main()
