"""Regression tests for convert.py. Stdlib only; builds synthetic bundles in a temp dir and never touches real exports.

Run:  python3 -I -m unittest discover -s skills/ai-export -p 'test_convert.py'
"""
import gzip
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CONVERT = os.path.join(HERE, "convert.py")
ALLOWED_KEYS = {"type", "created", "source", "conversation_id", "title", "conv_created", "conv_updated",
                "model", "triage", "url", "related_to", "tags", "belongs_to"}
INDEX_KEYS = {"type", "created", "source", "tags", "related_to"}
PROJECT = "g-p-" + "a1b2c3d4" * 4
CID = "11111111-1111-1111-1111-111111111111"


def msg(role, text, t, model=None, recipient=None):
    m = {"author": {"role": role}, "content": {"content_type": "text", "parts": [text]}, "create_time": t, "metadata": {}}
    if model is not None:
        m["metadata"]["model_slug"] = model
    if recipient:
        m["recipient"] = recipient
    return m


def conv(cid=CID, title="A title", model="gpt-5", text="hello"):
    mp = {
        "root": {"id": "root", "parent": None, "children": ["u1"], "message": None},
        "u1": {"id": "u1", "parent": "root", "children": ["a1", "a1b"], "message": msg("user", text, 1760000000)},
        "a1": {"id": "a1", "parent": "u1", "children": ["u2"], "message": msg("assistant", "main", 1760000010, model)},
        "a1b": {"id": "a1b", "parent": "u1", "children": [], "message": msg("assistant", "alt", 1760000005, model)},
        "u2": {"id": "u2", "parent": "a1", "children": [], "message": msg("user", "follow up", 1760000020)},
    }
    return {"conversation_id": cid, "title": title, "create_time": 1760000000, "update_time": 1760000020,
            "mapping": mp, "current_node": "u2"}


def bundle(convs, **kw):
    b = {"platform": "chatgpt", "kind": "project", "project": PROJECT, "pulled_at": "2026-10-16T00:00:00Z", "since": None,
         "listing": [], "attachments": [], "errors": [], "conversations": convs}
    b.update(kw)
    return b


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def frontmatter(path):
    text = read(path)
    assert text.startswith("---\n"), path
    return text[4:text.index("\n---\n", 4)].split("\n")


def fm_keys(lines):
    return {l.split(":", 1)[0] for l in lines if l and not l.startswith((" ", "-"))}


class ConvertBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_convert(self, b, *extra, expect_ok=True):
        data = os.path.join(self.tmp.name, "data")
        os.makedirs(data, exist_ok=True)
        inp = os.path.join(data, "bundle.json")
        with open(inp, "w", encoding="utf-8") as f:
            json.dump(b, f)
        out = os.path.join(self.tmp.name, "out%d" % len(os.listdir(self.tmp.name)))
        r = subprocess.run([sys.executable, "-I", CONVERT, "--input", inp, "--out-dir", out, "--date", "2026-10-16", *extra],
                           capture_output=True, text=True, timeout=120)
        if expect_ok:
            self.assertEqual(r.returncode, 0, r.stderr)
            return out, json.loads(r.stdout)
        return out, r

    def assert_frontmatter_clean(self, out):
        for name in os.listdir(out):
            lines = frontmatter(os.path.join(out, name))
            keys = fm_keys(lines)
            allowed = INDEX_KEYS if name.endswith("-index.md") else ALLOWED_KEYS
            self.assertLessEqual(keys, allowed, (name, keys - allowed))
            self.assertNotIn("_organized", keys)


class ConvertTest(ConvertBase):
    # ---- fix 1: frontmatter injection
    def test_model_slug_injection(self):
        out, summ = self.run_convert(bundle([conv(model="gpt-5\n_organized: true\nevil: 1")]))
        self.assert_frontmatter_clean(out)
        text = read(os.path.join(out, "a-title.md"))
        self.assertNotIn("evil", text)
        self.assertIn('model: ""', text)

    def test_good_model_is_quoted(self):
        out, _ = self.run_convert(bundle([conv(model="gpt-5-thinking")]))
        self.assertIn('model: "gpt-5-thinking"', read(os.path.join(out, "a-title.md")))

    def test_project_injection_drops_url(self):
        out, _ = self.run_convert(bundle([conv()], project=PROJECT + "\nevil: 1"))
        self.assert_frontmatter_clean(out)
        text = read(os.path.join(out, "a-title.md"))
        self.assertNotIn("evil", text)
        self.assertIn('url: "https://chatgpt.com/c/%s"' % CID, text)   # falls back to the bare thread url

    def test_valid_project_url(self):
        out, _ = self.run_convert(bundle([conv()]))
        self.assertIn('url: "https://chatgpt.com/g/%s/c/%s"' % (PROJECT, CID), read(os.path.join(out, "a-title.md")))

    def test_conversation_id_trailing_newline_rejected(self):
        out, _ = self.run_convert(bundle([conv(cid=CID + "\n")]))
        self.assert_frontmatter_clean(out)
        text = read(os.path.join(out, "a-title.md"))
        self.assertIn('conversation_id: ""', text)
        self.assertNotIn("url:", text)

    def test_timestamps_are_safe(self):
        for bad in (10 ** 30, -10 ** 18, "2026-13-45", "x\ny: z", 1e400, True, [1]):
            c = conv()
            c["create_time"] = bad
            c["update_time"] = bad
            out, _ = self.run_convert(bundle([c]))
            self.assert_frontmatter_clean(out)
            for l in frontmatter(os.path.join(out, "a-title.md")):
                if l.startswith(("conv_created:", "conv_updated:")):
                    self.assertRegex(l.split(":", 1)[1].strip(), r"^[0-9T:Z-]*$")

    def test_title_injection(self):
        out, _ = self.run_convert(bundle([conv(title="Hi\n---\n_organized: true\n")]))
        self.assert_frontmatter_clean(out)

    # ---- fix 2: token check
    def test_text_mention_is_only_a_note(self):
        out, summ = self.run_convert(bundle([conv(text="const h = {Authorization: 'Bearer ' + s.accessToken}")]))
        joined = " ".join(summ["warnings"])
        self.assertNotIn("TOKEN WARNING", joined)
        self.assertIn("note:", joined)
        self.assertTrue(os.listdir(out))

    def test_token_key_outside_text_is_warned(self):
        b = bundle([conv()], accessToken="eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig")
        _, summ = self.run_convert(b)
        self.assertTrue(any("TOKEN WARNING" in w and "JWT-shaped" in w for w in summ["warnings"]), summ["warnings"])

    def test_nested_access_token_key_is_warned(self):
        c = conv()
        c["mapping"]["u1"]["message"]["metadata"]["access_token"] = "opaque"
        _, summ = self.run_convert(bundle([c]))
        self.assertTrue(any("TOKEN WARNING" in w for w in summ["warnings"]))

    # ---- fix 3: exact written list
    def test_written_matches_disk(self):
        out, summ = self.run_convert(bundle([conv(), conv(cid="22222222-2222-2222-2222-222222222222", title="Other")]))
        self.assertEqual(sorted(summ["written"]), sorted(os.listdir(out)))
        self.assertIn(summ["index"], summ["written"])
        self.assertEqual(summ["notes"], 2)

    # ---- fix 5: memory blowup
    def test_shared_nodes_across_branches_are_bounded(self):
        mp = {}
        n = 200
        for i in range(n):
            mp["p%d" % i] = {"parent": ("p%d" % (i - 1)) if i else None,
                             "children": (["p%d" % (i + 1)] if i < n - 1 else []) + ["x0"],
                             "message": msg("user", "p", 1760000000 + i)}
        for j in range(50):
            mp["x%d" % j] = {"parent": "p0", "children": ["x%d" % (j + 1)] if j < 49 else [],
                             "message": msg("assistant", "Z" * 100000, 1760001000 + j)}
        c = {"conversation_id": CID, "title": "dag", "mapping": mp, "current_node": "p%d" % (n - 1)}
        start = time.time()
        out, summ = self.run_convert(bundle([c]))
        size = os.path.getsize(os.path.join(out, "dag.md"))
        self.assertLess(time.time() - start, 60)
        self.assertLess(size, 10 * 1000 * 1000)   # 50 shared nodes of 100 kB, rendered once (about 5 MB), not 200 times
        self.assertEqual(summ["branches"], 1)

    def test_branch_budget_stops_rendering(self):
        mp = {"root": {"parent": None, "children": ["u"], "message": None},
              "u": {"parent": "root", "children": [], "message": msg("user", "q", 1760000000)}}
        kids = ["k%d" % i for i in range(150)]
        mp["u"]["children"] = ["m"] + kids
        mp["m"] = {"parent": "u", "children": [], "message": msg("assistant", "main", 1760000001)}
        for k in kids:
            mp[k] = {"parent": "u", "children": [], "message": msg("assistant", "B" * 900000, 1760000002)}
        c = {"conversation_id": CID, "title": "wide", "mapping": mp, "current_node": "m"}
        out, _ = self.run_convert(bundle([c]))
        size = os.path.getsize(os.path.join(out, "wide.md"))
        self.assertLess(size, 6 * 1000 * 1000)
        self.assertIn("output budget", read(os.path.join(out, "wide.md")))

    # ---- voice turns and long branches (shapes seen in a real account pull; synthetic text only)
    def test_voice_turns_render_their_transcription_marked_voice(self):
        def part(t, text):
            return {"content_type": "audio_transcription", "text": text, "direction": t, "decoding_id": None}
        mp = {"root": {"parent": None, "children": ["u"], "message": None},
              "u": {"parent": "root", "children": ["a"], "message": msg("user", "x", 1760000000)},
              "a": {"parent": "u", "children": ["u2"], "message": msg("assistant", "x", 1760000001, "gpt-5")},
              "u2": {"parent": "a", "children": [], "message": msg("user", "typed question", 1760000002)}}
        mp["u"]["message"]["content"] = {"content_type": "multimodal_text", "parts": [part("in", "spoken question one")]}
        mp["a"]["message"]["content"] = {"content_type": "multimodal_text", "parts": [
            part("out", "spoken answer one"), {"content_type": "audio_asset_pointer", "asset_pointer": "file-service://file-x"}]}
        c = {"conversation_id": CID, "title": "voice", "mapping": mp, "current_node": "u2"}
        out, summ = self.run_convert(bundle([c]))
        text = read(os.path.join(out, "voice.md"))
        self.assertIn("spoken question one", text)
        self.assertIn("spoken answer one", text)
        self.assertRegex(text, r"## User · [^\n]* · voice\n")
        self.assertRegex(text, r"## Assistant · [^\n]* · gpt-5 · voice\n")
        self.assertNotIn("file-service", text)
        self.assertEqual(text.count(" · voice"), 2)   # the typed turn is not marked

    def test_off_path_branch_over_500_messages_is_not_cut(self):
        mp = {"root": {"parent": None, "children": ["u"], "message": None},
              "u": {"parent": "root", "children": ["m", "b0"], "message": msg("user", "q", 1760000000)},
              "m": {"parent": "u", "children": [], "message": msg("assistant", "main", 1760000001)}}
        for i in range(650):
            mp["b%d" % i] = {"parent": "b%d" % (i - 1) if i else "u", "children": ["b%d" % (i + 1)] if i < 649 else [],
                             "message": msg("assistant" if i % 2 == 0 else "user", "alt-%d-end" % i, 1760000100 + i)}
        c = {"conversation_id": CID, "title": "long", "mapping": mp, "current_node": "m"}
        out, summ = self.run_convert(bundle([c]))
        text = read(os.path.join(out, "long.md"))
        self.assertIn("alt-649-end", text)
        self.assertEqual(len(re.findall(r"alt-\d+-end", text)), 650)
        self.assertNotIn("branch truncated", text)

    # ---- nits
    def test_index_name_collision(self):
        out, summ = self.run_convert(bundle([conv(title="chatgpt %s pull 2026-10-16 index" % PROJECT[4:12])]))
        self.assertEqual(len(summ["written"]), len(set(summ["written"])))
        self.assertEqual(len(os.listdir(out)), 2)

    def test_non_string_conversation_id(self):
        c = conv()
        c["conversation_id"] = ["x"]
        c["id"] = {"y": 1}
        self.run_convert(bundle([c]))

    def test_index_name_has_project_short_id(self):
        _, a = self.run_convert(bundle([conv()]))
        _, b = self.run_convert(bundle([conv()], project="g-p-" + "f" * 32))
        self.assertIn(PROJECT[4:12], a["index"])
        self.assertNotEqual(a["index"], b["index"])

    def test_thread_index_name_uses_conversation_id(self):
        _, a = self.run_convert(bundle([conv()], kind="thread", project=None))
        self.assertIn(CID[:8], a["index"])

    def test_no_literal_private_use_chars_in_source(self):
        src = read(CONVERT)
        self.assertEqual([c for c in src if 0xE000 <= ord(c) <= 0xF8FF], [])

    def test_traversal_title_and_prefix(self):
        out, summ = self.run_convert(bundle([conv(title="../../etc/passwd\n")]), "--slug-prefix", "../x")
        for name in summ["written"]:
            self.assertRegex(name, r"^[a-z0-9-]+\.md$")
        self.assertEqual(sorted(os.listdir(out)), sorted(summ["written"]))

    def test_refuses_other_platforms(self):
        _, r = self.run_convert(bundle([conv()], platform="claude"), expect_ok=False)
        self.assertNotEqual(r.returncode, 0)

    def test_default_frontmatter_has_only_generic_keys(self):
        out, _ = self.run_convert(bundle([conv()]))
        for name in os.listdir(out):
            self.assertLessEqual(fm_keys(frontmatter(os.path.join(out, name))), ALLOWED_KEYS)

    def test_id_key_and_fm_are_opt_in(self):
        out, _ = self.run_convert(bundle([conv()]), "--id-key", "uid", "--fm", "para=resource", "--fm", 'note=a "quoted"\nvalue')
        for name in os.listdir(out):
            lines = frontmatter(os.path.join(out, name))
            keys = fm_keys(lines)
            self.assertLessEqual(keys, ALLOWED_KEYS | {"uid", "para", "note"})
            self.assertEqual(lines[0].split(":")[0], "uid")
            self.assertIn("para", keys)
            self.assertNotIn("evil", keys)

    def test_fm_refuses_reserved_and_builtin_keys(self):
        for bad in ("_organized=true", "type=x", "bad key=1", "noequals"):
            _, r = self.run_convert(bundle([conv()]), "--fm", bad, expect_ok=False)
            self.assertNotEqual(r.returncode, 0, bad)
        _, r = self.run_convert(bundle([conv()]), "--id-key", "_id", expect_ok=False)
        self.assertNotEqual(r.returncode, 0)


    def test_canvas_docs_and_since_cutoff(self):
        c = conv()
        c["mapping"]["a1"]["message"]["metadata"]["canvas"] = {"textdoc_id": "td_abcdef12", "title": "Plan"}
        b = bundle([c], started_at="2026-10-15T23:59:00.000Z", stop_reason="complete",
                   textdocs={"td_abcdef12": {"id": "td_abcdef12", "title": "Plan", "textdoc_type": "document",
                                             "version": 3, "content": "# Heading\n```js\nx\n```"}})
        out, summary = self.run_convert(b)
        note = [n for n in summary["written"] if not n.endswith("-index.md")][0]
        text = read(os.path.join(out, note))
        self.assertIn("## Canvas documents", text)
        self.assertIn("````markdown\n# Heading", text)
        idx = read(os.path.join(out, summary["index"]))
        self.assertIn("| Next --since cutoff | `2026-10-15T23:59:00.000Z` |", idx)
        # without the doc in the bundle the note says so instead of dropping it
        b.pop("textdocs")
        out, summary = self.run_convert(b)
        note = [n for n in summary["written"] if not n.endswith("-index.md")][0]
        self.assertIn("not in this bundle", read(os.path.join(out, note)))

    def test_no_cutoff_for_partial_bundle(self):
        out, summary = self.run_convert(bundle([conv()], started_at="2026-10-15T23:59:00Z", partial=True))
        self.assertNotIn("Next --since cutoff", read(os.path.join(out, summary["index"])))


# ---------------------------------------------------------------- account pulls (schema-3 parts)

RUN = "20261110T120000Z-abc123"
RUN2 = "20261111T090000Z-def456"
P1 = "g-p-" + "b" * 32
ACCOUNT_KEYS = ALLOWED_KEYS | {"project", "project_name"}


def uid(n):
    return "00000000-0000-4000-8000-%012x" % n


def row(n, title=None, project=None, name=None):
    return {"id": uid(n), "title": title if title is not None else "Thread %d" % n, "create_time": "2025-10-09T00:00:00Z",
            "update_time": "2025-10-09T08:53:24Z", "sources": ["project"] if project else ["main"],
            "project": project, "project_name": name, "triage": None}


def apart(idx, final, convs, listing, run=RUN, **kw):
    b = {"platform": "chatgpt", "schema": 3, "kind": "account", "project": None, "run_id": run, "resume_of": None, "part": idx,
         "final": final, "started_at": "2026-11-10T12:00:00.000Z", "pulled_at": "2026-11-10T13:00:00.000Z", "since": None,
         "partial": False, "listing_complete": True, "stop_reason": "complete", "error": None, "capped": False,
         "remaining": 0 if final else None, "listing_skipped": False, "list_only": False, "fetch_unchanged": False, "only_ids": None,
         "sources": {"main": {"stop_reason": "complete", "count": 1, "pages": 1, "new": 1},
                     "archived": {"stop_reason": "complete", "count": 0, "pages": 1, "new": 0},
                     "projects": {"stop_reason": "complete", "count": 1, "pages": 1},
                     "project_threads": {P1: {"name": "Proj One", "stop_reason": "complete", "count": 1, "pages": 1}}},
         "ids": [c["conversation_id"] for c in convs], "listing": listing, "conversations": convs, "attachments": [], "errors": []}
    b.update(kw)
    return b


def pname(b):
    return "chatgpt-account-%s-part-%03d.json" % (b["run_id"], b["part"])


class AccountConvertTest(ConvertBase):
    def write_parts(self, parts, sub="data", gz=False):
        d = os.path.join(self.tmp.name, sub)
        os.makedirs(d, exist_ok=True)
        paths = []
        for b in parts:
            path = os.path.join(d, pname(b) + (".gz" if gz else ""))
            with (gzip.open(path, "wt", encoding="utf-8") if gz else open(path, "w", encoding="utf-8")) as f:
                json.dump(b, f)
            paths.append(path)
        return d, paths

    def convert_inputs(self, inputs, *extra, expect_ok=True):
        out = os.path.join(self.tmp.name, "out%d" % len(os.listdir(self.tmp.name)))
        argv = [sys.executable, "-I", CONVERT, "--out-dir", out, "--date", "2026-11-10"]
        for i in inputs:
            argv += ["--input", i]
        r = subprocess.run(argv + list(extra), capture_output=True, text=True, timeout=120)
        if expect_ok:
            self.assertEqual(r.returncode, 0, r.stderr)
            return out, json.loads(r.stdout)
        return out, r

    def pull(self):
        listing = [row(1, project=P1, name="Proj One"), row(2), row(3)]
        return [apart(0, False, [conv(uid(1), "Thread 1"), conv(uid(2), "Thread 2")], listing),
                apart(1, True, [conv(uid(3), "Thread 3")], listing)]

    def test_parts_dir_is_one_pull_with_project_frontmatter(self):
        d, _ = self.write_parts(self.pull())
        out, summ = self.convert_inputs([d])
        self.assertEqual(summ["notes"], 3)
        self.assertEqual(summ["index"], "chatgpt-account-pull-2026-11-10-index.md")
        self.assertEqual(sorted(summ["written"]), sorted(os.listdir(out)))
        self.assertEqual(summ["parts"], 2)
        for name in os.listdir(out):
            keys = fm_keys(frontmatter(os.path.join(out, name)))
            self.assertLessEqual(keys, INDEX_KEYS if name.endswith("-index.md") else ACCOUNT_KEYS, name)
        t1 = read(os.path.join(out, "thread-1.md"))
        self.assertIn('project: "%s"' % P1, t1)
        self.assertIn('project_name: "Proj One"', t1)
        self.assertIn('url: "https://chatgpt.com/g/%s/c/%s"' % (P1, uid(1)), t1)
        self.assertIn("source: chatgpt-account", t1)
        t2 = read(os.path.join(out, "thread-2.md"))
        self.assertIn('project: ""', t2)
        self.assertIn('url: "https://chatgpt.com/c/%s"' % uid(2), t2)
        idx = read(os.path.join(out, summ["index"]))
        self.assertIn("# ChatGPT account pull, 2026-11-10", idx)
        self.assertIn("| Next --since cutoff | `2026-11-10T12:00:00.000Z` |", idx)
        self.assertIn("Listing: 3 threads", idx)
        self.assertEqual(idx.count(pname(self.pull()[0])), 1)
        self.assertIn("Proj One", idx)

    def test_repeated_titles_get_short_id_suffixes_whatever_the_order(self):
        ids = ["%08x-0000-4000-8000-%012x" % (0xa0000000 + n, n) for n in range(1, 7)]
        titles = ["Same", "Same", "same!", "Other", "", ""]
        listing = [dict(row(1, t), id=i) for i, t in zip(ids, titles)]
        convs = [conv(i, t) for i, t in zip(ids, titles)]
        parts = [apart(0, False, convs[:3], listing), apart(1, True, convs[3:], listing)]
        _, paths = self.write_parts(parts)
        _, a = self.convert_inputs(paths)
        _, b = self.convert_inputs(list(reversed(paths)))
        self.assertEqual(sorted(a["written"]), sorted(b["written"]))
        notes = sorted(n for n in a["written"] if not n.endswith("-index.md"))
        self.assertEqual(notes, sorted(["same-%s.md" % i[:8] for i in ids[:3]] + ["other.md"] +
                                       ["untitled-%s.md" % i[:8] for i in ids[4:]]))
        # same title AND same 8-char id prefix: the whole id is used, still independent of the part order
        listing = [row(1, "Same"), row(2, "Same")]
        parts = [apart(0, False, [conv(uid(1), "Same")], listing), apart(1, True, [conv(uid(2), "Same")], listing)]
        _, paths = self.write_parts(parts, sub="dup")
        _, a = self.convert_inputs(list(reversed(paths)))
        self.assertEqual(sorted(n for n in a["written"] if not n.endswith("-index.md")),
                         sorted("same-%s.md" % uid(n).replace("-", "") for n in (1, 2)))

    def test_resume_copy_wins_and_missing_is_reported(self):
        listing = [row(1), row(2), row(3)]
        prim = apart(0, False, [conv(uid(1), "Thread 1"), conv(uid(2), "old copy")], listing)
        _, paths = self.write_parts([prim])
        out, summ = self.convert_inputs(paths)
        self.assertEqual(summ["missing"], 1)
        idx = read(os.path.join(out, summ["index"]))
        self.assertNotIn("Next --since cutoff", idx)
        self.assertIn("Listed but in no part (1)", idx)
        self.assertIn(uid(3), idx)
        res = apart(0, True, [conv(uid(2), "new copy"), conv(uid(3), "Thread 3")], [], run=RUN2, resume_of=RUN,
                    listing_skipped=True, sources=None, stop_reason="skipped", only_ids=[uid(2), uid(3)],
                    started_at="2026-11-11T09:00:00.000Z")
        _, more = self.write_parts([res])
        out, summ = self.convert_inputs(paths + more)
        self.assertEqual((summ["notes"], summ["missing"]), (3, 0))
        self.assertIn('title: "new copy"', read(os.path.join(out, "thread-2.md")))
        self.assertIn("| Next --since cutoff | `2026-11-10T12:00:00.000Z` |", read(os.path.join(out, summ["index"])))

    def test_refuses_ambiguous_inputs(self):
        _, paths = self.write_parts(self.pull())
        _, r = self.convert_inputs(paths + [paths[0]], expect_ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("given 2 times", r.stderr)
        other = apart(0, True, [conv(uid(9))], [row(9)], run="20261109T000000Z-999999")
        _, op = self.write_parts([other], sub="other")
        _, r = self.convert_inputs(paths + op, expect_ok=False)
        self.assertIn("mismatched run ids", r.stderr)
        proj = os.path.join(self.tmp.name, "proj.json")
        with open(proj, "w") as f:
            json.dump(bundle([conv()]), f)
        _, r = self.convert_inputs(paths + [proj], expect_ok=False)
        self.assertIn("not an account part", r.stderr)
        self.assertEqual([n for n in os.listdir(self.tmp.name) if n.startswith("out")], [], "refused before writing anything")

    def test_token_in_a_part_is_warned_and_fm_project_is_refused(self):
        parts = self.pull()
        parts[1]["accessToken"] = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig"
        d, _ = self.write_parts(parts)
        _, summ = self.convert_inputs([d])
        self.assertTrue(any("TOKEN WARNING" in w and pname(parts[1]) in w for w in summ["warnings"]), summ["warnings"])
        _, r = self.convert_inputs([d], "--fm", "project=x", expect_ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.run_convert(bundle([conv()]), "--fm", "project=x")   # still allowed for project bundles

    def test_hostile_listing_title_and_gzip_part(self):
        listing = [row(1, "../../etc/passwd\n---\n_organized: true"), row(2)]
        parts = [apart(0, True, [conv(uid(1), "x"), conv(uid(2), "y")], listing)]
        _, paths = self.write_parts(parts, gz=True)
        out, summ = self.convert_inputs(paths)
        for name in summ["written"]:
            self.assertRegex(name, r"^[a-z0-9-]+\.md$")
        self.assert_frontmatter_clean_account(out)

    def assert_frontmatter_clean_account(self, out):
        for name in os.listdir(out):
            keys = fm_keys(frontmatter(os.path.join(out, name)))
            self.assertLessEqual(keys, INDEX_KEYS if name.endswith("-index.md") else ACCOUNT_KEYS, name)
            self.assertNotIn("_organized", keys)


if __name__ == "__main__":
    unittest.main()
