"""Regression tests for convert.py. Stdlib only; builds synthetic bundles in a temp dir and never touches real exports.

Run:  python3 -I -m unittest discover -s skills/ai-export -p 'test_convert.py'
"""
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
ALLOWED_KEYS = {"strata_id", "type", "created", "source", "conversation_id", "title", "conv_created", "conv_updated",
                "model", "triage", "url", "related_to", "tags", "belongs_to"}
INDEX_KEYS = {"strata_id", "type", "created", "source", "tags", "related_to"}
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


class ConvertTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
