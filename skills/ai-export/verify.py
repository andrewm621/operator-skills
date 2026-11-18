#!/usr/bin/env python3
"""verify.py -- completeness checks for an ai-export ChatGPT bundle, and the helpers that make re-pulls repeatable.

Run it isolated, with every path passed as an argument:

    python3 -I verify.py check --input data/bundle.json[.gz] [--expected-count 60] [--notes-dir out/] \
        [--report-md out/run-report.md] [--json]
    python3 -I verify.py spot  --input data/bundle.json[.gz] --thread <conversation id> [--live live.json]
    python3 -I verify.py since --archive-dir ~/AI-Archive/chatgpt/raw --project g-p-<hex>
    python3 -I verify.py since --index-note <vault>/…-pull-2026-11-08-index.md
    python3 -I verify.py check   --input data/ [--notes-dir out/] [--part-only]   # account parts (schema 3), or --input per part
    python3 -I verify.py missing --input data/ [--limit 1000]   # ids still to fetch, as a JSON array for CFG.onlyIds
    python3 -I verify.py since   --archive-dir ~/AI-Archive/chatgpt/raw --account

Account `check` also fails on a missing or duplicated part, a run with no final part, mismatched run ids, a
to-fetch thread present in no part, and any listing source (main, archived, sidebar, each project) that did not end
`complete` (`since_cutoff` is accepted for the main list of an incremental pull only).

`check` fails loudly (exit 1) on anything that means the bundle or the notes rendered from it are missing
something: an incomplete listing, a thread that was listed but not fetched, a mapping node that cannot be reached
from the root, a message that convert.py should have rendered but did not, an unknown content type, or a part
convert.py throws away. Things that are left out on purpose (hidden reasoning, empty tool output, ChatGPT's own
redaction stubs) and objects that live outside the conversation JSON (canvas docs, Pages, library files, uploads,
images, sandbox files, shared links) are counted and named, per thread, so a gap is never silent.

The bundle is UNTRUSTED data. Like convert.py this only parses JSON and writes text: no eval/exec, no subprocess,
no network, stdlib only. Rendering is measured by running convert.py's own functions (loaded from the file next to
this one, or --convert), so "what convert.py renders" is never a second, drifting copy of its rules.
"""
import argparse
import collections
import datetime
import gzip
import importlib.util
import json
import os
import re
import sys
import types

MAX_INPUT_MB = 256
EXIT_FAIL = 1

RENDERED_PART_TYPES = {"image_asset_pointer", "audio_transcription"}   # dict parts convert.py renders (a marker / the spoken text)
AUDIO_POINTER_TYPES = {"audio_asset_pointer", "real_time_user_audio_video_asset_pointer"}   # audio files: listed as outside the JSON
# Content types convert.py knows how to render (content_text); anything else is "unknown" and named.
RENDERED_TYPES = {"text", "multimodal_text", "code", "execution_output", "tether_browsing_display", "tether_quote",
                  "sonic_webpage"}
# Content types convert.py deliberately leaves out. Counted and named, never silent.
POLICY_SKIPPED = {"thoughts": "hidden reasoning", "reasoning_recap": "reasoning summary ('Thought for …')",
                  "user_editable_context": "custom instructions", "model_editable_context": "model memory context",
                  "system_error": "system error"}
# Metadata keys that can carry a tool's real output when its content is empty.
METADATA_PAYLOAD_KEYS = {"aggregate_result", "jit_plugin_data", "connector_tool_payload", "chatgpt_sdk"}
REDACTION_STUB_RE = re.compile(r"\s*the output of this plugin was redacted\.?\s*", re.I)
CONV_ID_RE = re.compile(r"[0-9a-fA-F-]{36}")
PROJECT_RE = re.compile(r"g-p-[A-Za-z0-9-]{8,64}")
ACCOUNT_PART_NAME_RE = re.compile(r"chatgpt-account-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}-part-[0-9]{3}\.json(?:\.gz)?")   # = convert.PART_NAME_RE

# References to objects that are NOT inside the conversation JSON and need their own fetch.
REF_PATTERNS = {
    "page": re.compile(r"\bpage_[0-9a-f]{24,40}\b"),
    "library_file": re.compile(r"\blibfile_[0-9a-f]{24,40}\b"),
    "sandbox_file": re.compile(r"sandbox:(/mnt/data/[^\s)\]\"'<>`]{1,300})"),
    "shared_link": re.compile(r"https://chatgpt\.com/share/[0-9a-f-]{36}"),
}
ASSET_RE = re.compile(r"(?:file-service|sediment)://[A-Za-z0-9_-]{4,80}")


def die(msg, code=2):
    print("verify.py: " + msg, file=sys.stderr)
    sys.exit(code)


def as_dict(x):
    return x if isinstance(x, dict) else {}


def as_list(x):
    return x if isinstance(x, list) else []


def short(s, n=80):
    s = re.sub(r"[\x00-\x1f\x7f]", " ", str(s if s is not None else ""))
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def load_convert(path):
    """Load convert.py by path (never from the bundle's folder) so rendering is measured with the real code."""
    path = os.path.realpath(path)
    if not os.path.isfile(path):
        die("convert.py not found at %s (pass --convert)" % path)
    spec = importlib.util.spec_from_file_location("ai_export_convert", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for name in ("render_message", "convert_conversation", "to_epoch", "iso", "TOOL_RESULT_CHARS",
                 "TOOL_CALL_CHARS", "MAX_MESSAGE_CHARS", "account_plan", "part_header", "read_json_file", "expand_inputs",
                 "is_account_part", "conv_key", "PartError", "PART_NAME_RE", "UUID_RE", "REQUIRED_SOURCES"):
        if not hasattr(mod, name):
            die("convert.py at %s has no %s; verify.py and convert.py are out of step" % (path, name))
    return mod


def read_bundle(path, max_mb=MAX_INPUT_MB):
    real = os.path.realpath(path)
    if not os.path.isfile(real):
        die("input is not a file: " + path)
    with open(real, "rb") as f:
        head = f.read(2)
    opener = gzip.open if head == b"\x1f\x8b" else open
    with opener(real, "rb") as f:
        raw = f.read(max_mb * 1024 * 1024 + 1)
    if len(raw) > max_mb * 1024 * 1024:
        die("input is over the %d MB guard (uncompressed)" % max_mb)
    try:
        bundle = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as e:
        die("input is not valid JSON: %s" % type(e).__name__)
    if not isinstance(bundle, dict):
        die("bundle must be a JSON object")
    return bundle


class Findings:
    """FAIL = something is missing or cannot be accounted for. WARN = worth a look. INFO = named, expected gaps."""

    def __init__(self):
        self.items = []

    def add(self, level, scope, msg):
        self.items.append({"level": level, "scope": scope, "msg": msg})

    def count(self, level):
        return sum(1 for i in self.items if i["level"] == level)


# ---------------------------------------------------------------- tree checks

def tree_check(conv):
    mapping = as_dict(conv.get("mapping"))
    roots = [nid for nid, n in mapping.items() if as_dict(n).get("parent") in (None, "") or as_dict(n).get("parent") not in mapping]
    dangling = sum(1 for n in mapping.values() for k in as_list(as_dict(n).get("children")) if k not in mapping)
    seen, stack = set(), list(roots)
    while stack:
        nid = stack.pop()
        if nid in seen or nid not in mapping:
            continue
        seen.add(nid)
        stack.extend(k for k in as_list(as_dict(mapping[nid]).get("children")) if isinstance(k, str))
    mismatched = 0
    for nid, n in mapping.items():
        for k in as_list(as_dict(n).get("children")):
            if k in mapping and as_dict(mapping[k]).get("parent") != nid:
                mismatched += 1
    current = conv.get("current_node")
    path, node = [], current
    guard = set()
    while isinstance(node, str) and node in mapping and node not in guard:
        guard.add(node)
        path.append(node)
        node = as_dict(mapping[node]).get("parent")
    path.reverse()
    leaves = sum(1 for n in mapping.values() if not as_list(as_dict(n).get("children")))
    return {"nodes": len(mapping), "roots": len(roots), "unreachable": len(mapping) - len(seen), "dangling_children": dangling,
            "parent_mismatch": mismatched, "current_ok": isinstance(current, str) and current in mapping,
            "path_reaches_root": bool(path) and path[0] in roots, "path": path, "leaves": leaves}


# ---------------------------------------------------------------- message accounting

def content_is_empty(content):
    content = as_dict(content)
    ct = content.get("content_type")
    if ct == "thoughts":
        return not any(as_dict(t).get("content") or as_dict(t).get("summary") for t in as_list(content.get("thoughts")))
    if ct == "reasoning_recap":
        return not (isinstance(content.get("content"), str) and content["content"].strip())
    parts = as_list(content.get("parts"))
    if any(isinstance(p, dict) for p in parts):
        return False
    if any(isinstance(p, str) and p.strip() for p in parts):
        return False
    for key in ("text", "result"):
        if isinstance(content.get(key), str) and content[key].strip():
            return False
    return True


def tool_name(msg):
    """Namespace of a tool (obfuscated plugin ids collapse to 'plugin:<id>')."""
    author = as_dict(msg.get("author"))
    name = author.get("name") if author.get("role") == "tool" else msg.get("recipient")
    name = name if isinstance(name, str) and name else "?"
    return short(name, 60)


def classify(msg, cv):
    """Expected outcome for one mapping message: (bucket, label). Buckets: hidden, policy, empty, redacted, render."""
    msg = as_dict(msg)
    author = as_dict(msg.get("author"))
    role = author.get("role")
    meta = as_dict(msg.get("metadata"))
    content = as_dict(msg.get("content"))
    ct = content.get("content_type")
    if role not in ("user", "assistant", "tool"):
        return "hidden", "%s message" % short(role, 20)
    if meta.get("is_visually_hidden_from_conversation") or meta.get("is_user_system_message"):
        rec = msg.get("recipient")
        return "hidden", "hidden in ChatGPT's UI (%s)" % (short(rec, 50) if rec not in (None, "all") else role)
    if ct in POLICY_SKIPPED:
        return "policy", POLICY_SKIPPED[ct]
    if content_is_empty(content):
        if role == "tool":
            if meta.get("search_result_groups") or as_dict(meta.get("inline_cot_expandable_content")).get("search_result_groups"):
                return "empty", "web search results held only in metadata, not rendered (%s)" % tool_name(msg)
            other = sorted(k for k, v in meta.items() if k in METADATA_PAYLOAD_KEYS and v)
            if other:
                return "empty", "tool output held only in metadata.%s (%s)" % ("/".join(other), tool_name(msg))
            return "empty", "empty tool output (%s)" % tool_name(msg)
        if role == "assistant" and msg.get("recipient") not in (None, "all"):
            return "empty", "empty tool call (%s)" % tool_name(msg)
        return "empty", "empty %s message" % role
    parts = as_list(content.get("parts"))
    text = "".join(p for p in parts if isinstance(p, str)) or (content.get("text") if isinstance(content.get("text"), str) else "")
    if REDACTION_STUB_RE.fullmatch(text or ""):
        return "redacted", "ChatGPT's 'output of this plugin was redacted' stub (%s)" % tool_name(msg)
    return "render", ct if isinstance(ct, str) else "none"


def account_messages(conv, row, bundle, cv, f, scope):
    """Run convert.py's own rendering and compare it with what should have rendered."""
    mapping = as_dict(conv.get("mapping"))
    by_obj = {}
    for nid, n in mapping.items():
        m = as_dict(n).get("message")
        if isinstance(m, dict):
            by_obj[id(m)] = nid
    rendered = set()
    real_render = cv.render_message

    def spy(msg, level):
        out = real_render(msg, level)
        if out[0] and id(msg) in by_obj:
            rendered.add(by_obj[id(msg)])
        return out

    cv.render_message = spy
    try:
        c = cv.convert_conversation(conv, row, bundle, types.SimpleNamespace(tag=[], related_to="", extra_fm=[], id_key=""))
    finally:
        cv.render_message = real_render

    buckets = collections.Counter()
    labels = collections.defaultdict(collections.Counter)
    roles = collections.Counter()
    expected, unknown_types, dropped_parts = set(), collections.Counter(), collections.Counter()
    trunc_tool, trunc_tool_chars, trunc_msg = 0, 0, 0
    policy_chars = 0
    for nid, n in mapping.items():
        m = as_dict(n).get("message")
        if not isinstance(m, dict):
            buckets["no_message"] += 1
            continue
        roles[as_dict(m.get("author")).get("role") or "?"] += 1
        bucket, label = classify(m, cv)
        buckets[bucket] += 1
        labels[bucket][label] += 1
        content = as_dict(m.get("content"))
        ct = content.get("content_type")
        if bucket == "policy":
            for t in as_list(content.get("thoughts")):
                policy_chars += len(str(as_dict(t).get("content") or ""))
        if bucket in ("render", "redacted"):
            expected.add(nid)
            if ct not in RENDERED_TYPES and not (ct is None and as_list(content.get("parts"))):
                unknown_types[str(ct)] += 1
            for p in as_list(content.get("parts")):
                if isinstance(p, dict) and p.get("content_type") not in RENDERED_PART_TYPES and p.get("content_type") not in AUDIO_POINTER_TYPES:
                    dropped_parts[str(p.get("content_type"))] += 1
            kind_text = "".join(p for p in as_list(content.get("parts")) if isinstance(p, str)) or str(content.get("text") or content.get("result") or "")
            role = as_dict(m.get("author")).get("role")
            is_tool = role == "tool" or ct in ("execution_output", "tether_quote", "tether_browsing_display", "sonic_webpage") or (
                role == "assistant" and m.get("recipient") not in (None, "all"))
            if len(kind_text) > cv.MAX_MESSAGE_CHARS:
                trunc_msg += 1
            if is_tool:
                limit = cv.TOOL_RESULT_CHARS if (role == "tool" or ct in ("execution_output", "tether_quote")) else cv.TOOL_CALL_CHARS
                if len(kind_text) > limit:
                    trunc_tool += 1
                    trunc_tool_chars += len(kind_text) - limit

    lost = expected - rendered
    extra = rendered - expected
    if lost:
        kinds = collections.Counter()
        for nid in lost:
            m = as_dict(as_dict(mapping[nid]).get("message"))
            kinds["%s/%s→%s" % (as_dict(m.get("author")).get("role"), as_as_str(as_dict(m.get("content")).get("content_type")), tool_name(m))] += 1
        f.add("FAIL", scope, "%d message(s) should have rendered but convert.py rendered nothing: %s" % (len(lost), fmt_counter(kinds)))
    if extra:
        f.add("WARN", scope, "%d node(s) rendered that the verifier classed as hidden/empty/skipped" % len(extra))
    if unknown_types:
        f.add("FAIL", scope, "unknown content_type(s), rendered by convert.py's text fallback at best: %s" % fmt_counter(unknown_types))
    if dropped_parts:
        f.add("FAIL", scope, "message part(s) convert.py drops silently: %s" % fmt_counter(dropped_parts))
    if trunc_msg:
        f.add("WARN", scope, "%d message(s) over convert.py's %d-char cap were cut" % (trunc_msg, cv.MAX_MESSAGE_CHARS))
    return {
        "message_nodes": sum(roles.values()), "roles": dict(roles), "buckets": dict(buckets),
        "labels": {k: dict(v) for k, v in labels.items()}, "expected_render": len(expected), "rendered": len(rendered),
        "lost": len(lost), "path_rendered": c.get("messages"), "branches": c.get("branches"),
        "tool_output_truncated": trunc_tool, "tool_output_chars_not_in_notes": trunc_tool_chars,
        "reasoning_chars_not_in_notes": policy_chars, "unknown_types": dict(unknown_types), "dropped_parts": dict(dropped_parts),
        "_rendered_ids": rendered,
    }


def as_as_str(x):
    return x if isinstance(x, str) else str(x)


def fmt_counter(c, limit=8):
    items = sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))
    s = ", ".join("%s ×%d" % (k, v) for k, v in items[:limit])
    return s + (", +%d more" % (len(items) - limit) if len(items) > limit else "")


def last_visible(conv, path):
    """Newest user/assistant message on the current path that the page shows as a turn (same rule as spot-check.js)."""
    mapping = as_dict(conv.get("mapping"))
    for nid in reversed(path):
        m = as_dict(as_dict(mapping.get(nid)).get("message"))
        role = as_dict(m.get("author")).get("role")
        if not m.get("create_time") or role not in ("user", "assistant"):
            continue
        if as_dict(m.get("metadata")).get("is_visually_hidden_from_conversation"):
            continue
        content = as_dict(m.get("content"))
        if any(isinstance(p, str) and p.strip() for p in as_list(content.get("parts"))) or (
                isinstance(content.get("text"), str) and content["text"].strip()):
            return m
    return None


# ---------------------------------------------------------------- external objects

def external_objects(conv):
    """Objects referenced by the thread that are not inside the conversation JSON. Ids only, no text."""
    mapping = as_dict(conv.get("mapping"))
    out = {k: {} for k in ("canvas", "page", "library_file", "attachment", "image", "audio", "sandbox_file",
                           "shared_link", "deep_research", "image_generation", "genui_card")}

    def note(kind, key, **info):
        entry = out[kind].setdefault(key, {"refs": 0})
        entry["refs"] += 1
        for k, v in info.items():
            if v is not None and k not in entry:
                entry[k] = v

    for n in mapping.values():
        m = as_dict(as_dict(n).get("message"))
        if not m:
            continue
        meta = as_dict(m.get("metadata"))
        content = as_dict(m.get("content"))
        rec = m.get("recipient") if isinstance(m.get("recipient"), str) else ""
        author = as_dict(m.get("author"))
        aname = author.get("name") if isinstance(author.get("name"), str) else ""
        canvas = as_dict(meta.get("canvas"))
        if isinstance(canvas.get("textdoc_id"), str):
            note("canvas", canvas["textdoc_id"], title=short(canvas.get("title"), 80) or None, type=canvas.get("textdoc_type"),
                 version=canvas.get("version"))
        if rec.startswith("canmore.") and rec != "canmore.create_textdoc":
            pass  # updates/comments are tied to an id through the tool response above
        for a in as_list(meta.get("attachments")):
            a = as_dict(a)
            if isinstance(a.get("id"), str):
                note("attachment", a["id"], name=short(a.get("name"), 100) or None, size=a.get("size"), mime=a.get("mime_type"),
                     library_file_id=a.get("library_file_id"))
        for p in as_list(content.get("parts")):
            p = as_dict(p)
            if p.get("content_type") == "image_asset_pointer" and isinstance(p.get("asset_pointer"), str):
                gen = as_dict(as_dict(p.get("metadata")).get("dalle")) or as_dict(as_dict(p.get("metadata")).get("generation"))
                kind = "image_generation" if (author.get("role") == "tool" and (gen or "dalle" in aname or "image_gen" in aname)) else "image"
                note(kind, p["asset_pointer"], width=p.get("width"), height=p.get("height"), size=p.get("size_bytes"))
        for p in as_list(content.get("parts")):
            p = as_dict(p)
            if p.get("content_type") in AUDIO_POINTER_TYPES:
                note("audio", p["asset_pointer"] if isinstance(p.get("asset_pointer"), str) else "?")
        if isinstance(meta.get("dictation_asset_pointer"), str):
            note("audio", meta["dictation_asset_pointer"])
        if isinstance(meta.get("model_dil_v2"), dict):
            note("genui_card", m.get("id") if isinstance(m.get("id"), str) else "?")
        if rec.startswith("research_kickoff_tool") or aname.startswith("research_kickoff_tool") or \
                meta.get("async_task_type") == "research" or "deep_research" in json.dumps(sorted(meta.keys())):
            note("deep_research", str(meta.get("async_task_id") or m.get("id") or "?"), title=short(meta.get("async_task_title"), 80) or None)
        blob = json.dumps(m, ensure_ascii=False)
        for kind, pat in REF_PATTERNS.items():
            for hit in set(pat.findall(blob)):
                note(kind, hit)
        for hit in set(ASSET_RE.findall(json.dumps(meta))):
            if hit != meta.get("dictation_asset_pointer"):
                note("image", hit)
    return {k: v for k, v in out.items() if v}


# ---------------------------------------------------------------- notes cross-check

FRONT_ID_RE = re.compile(r'^conversation_id: "([0-9a-fA-F-]{36})"\s*$', re.M)
BLOCK_RE = re.compile(r"^(?:#{2}|#{4}) (?:User|Assistant) · |^> \*\*tool (?:result|call)\*\* \(", re.M)


def notes_counts(notes_dir):
    real = os.path.realpath(notes_dir)
    if not os.path.isdir(real):
        die("--notes-dir is not a directory: " + notes_dir)
    counts = {}
    for name in sorted(os.listdir(real)):
        if not name.endswith(".md"):
            continue
        with open(os.path.join(real, name), encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        m = FRONT_ID_RE.search(text.split("\n---\n", 1)[0] if text.startswith("---") else "")
        if m:
            counts.setdefault(m.group(1), []).append((name, len(BLOCK_RE.findall(text))))
    return counts


# ---------------------------------------------------------------- check

def epoch(cv, t):
    return cv.to_epoch(t)


def run_check(args):
    cv = load_convert(args.convert)
    paths = expand(cv, args.input)
    if len(paths) > 1:
        return run_check_account(args, cv, paths)
    bundle = read_bundle(paths[0], args.max_input_mb)
    if cv.is_account_part(bundle):
        del bundle
        return run_check_account(args, cv, paths)
    f = Findings()
    if bundle.get("platform", "chatgpt") != "chatgpt":
        die("only ChatGPT bundles are supported (platform %r)" % bundle.get("platform"))
    kind = bundle.get("kind") if bundle.get("kind") in ("project", "thread") else "project"
    listing = [r for r in as_list(bundle.get("listing")) if isinstance(r, dict)]
    convs = [c for c in as_list(bundle.get("conversations")) if isinstance(c, dict)]
    errors = as_list(bundle.get("errors"))
    since = bundle.get("since")
    fetch_unchanged = bundle.get("fetch_unchanged") is True

    # ---- listing completeness
    if bundle.get("partial"):
        f.add("FAIL", "listing", "bundle is marked partial: the pull ended early")
    stop = bundle.get("stop_reason")
    if stop is None:
        f.add("INFO", "listing", "bundle predates stop_reason; `partial: false` is the only end-of-listing signal it carries")
    elif stop != "complete":
        f.add("FAIL", "listing", "listing did not end normally: stop_reason %r" % short(stop, 40))
    if bundle.get("list_only"):
        f.add("FAIL", "listing", "list-only preview bundle: no conversation bodies were fetched")
    ids = [r.get("id") for r in listing]
    dup = [k for k, v in collections.Counter(ids).items() if v > 1]
    if dup:
        f.add("FAIL", "listing", "%d id(s) listed more than once" % len(dup))
    bad_ids = [i for i in ids if not (isinstance(i, str) and CONV_ID_RE.fullmatch(i))]
    if bad_ids:
        f.add("FAIL", "listing", "%d listing row(s) without a valid conversation id" % len(bad_ids))
    if kind == "project":
        if args.expected_count is None:
            f.add("WARN", "listing", "listing count (%d) not compared with the project page: pass --expected-count N" % len(listing))
        elif args.expected_count != len(listing):
            f.add("FAIL", "listing", "listing has %d threads but the project page shows %d" % (len(listing), args.expected_count))
    triage = collections.Counter(r.get("triage") or "-" for r in listing)

    # ---- fetch completeness
    to_fetch = [r for r in listing if fetch_unchanged or r.get("triage") != "unchanged"]
    by_id = {}
    for c in convs:
        cid = c.get("conversation_id") or c.get("id")
        if isinstance(cid, str):
            if cid in by_id:
                f.add("FAIL", "fetch", "conversation %s appears twice" % cid)
            by_id[cid] = c
        else:
            f.add("FAIL", "fetch", "a conversation has no id")
    want = {r.get("id") for r in to_fetch}
    missing = [r for r in to_fetch if r.get("id") not in by_id]
    extra = [cid for cid in by_id if cid not in {r.get("id") for r in listing}]
    if missing:
        f.add("FAIL", "fetch", "%d listed thread(s) were not fetched: %s" % (len(missing), ", ".join(
            "%s (%s)" % (r.get("id"), short(r.get("title"), 40)) for r in missing[:10])))
    if extra:
        f.add("FAIL", "fetch", "%d conversation(s) not in the listing: %s" % (len(extra), ", ".join(extra[:10])))
    if len(by_id) != len(want) and not missing and not extra:
        f.add("FAIL", "fetch", "fetched %d conversations for %d expected" % (len(by_id), len(want)))
    if errors:
        f.add("FAIL", "fetch", "%d fetch error(s): %s" % (len(errors), ", ".join(
            "%s → %s" % (short(as_dict(e).get("id"), 40), short(as_dict(e).get("status"), 20)) for e in errors[:10])))
    if kind == "project" and since is not None and "fetch_unchanged" not in bundle:
        f.add("INFO", "fetch", "bundle predates fetch_unchanged; assumed unchanged threads were not fetched")

    # ---- canvas fetches (opt-in)
    textdocs = as_dict(bundle.get("textdocs"))
    textdoc_errors = as_list(bundle.get("textdoc_errors"))

    # ---- per thread
    rows = {r.get("id"): r for r in listing}
    notes = notes_counts(args.notes_dir) if args.notes_dir else None
    acc_state = ThreadTotals()
    for cid, conv in by_id.items():
        check_thread(cid, conv, rows.get(cid, {}), bundle, cv, f, notes, acc_state)
    if notes is not None:
        stray = [cid for cid in notes if cid not in by_id]
        if stray:
            f.add("FAIL", "notes", "%d note(s) in --notes-dir belong to conversations not in this bundle" % len(stray))
    for e in textdoc_errors:
        f.add("FAIL", "canvas", "canvas fetch failed: %s → %s" % (short(as_dict(e).get("id"), 40), short(as_dict(e).get("status"), 20)))

    summary = {"kind": kind, "project": bundle.get("project") if isinstance(bundle.get("project"), str) else None,
               "pulled_at": bundle.get("pulled_at"), "started_at": bundle.get("started_at"), "since": since,
               "stop_reason": stop, "partial": bool(bundle.get("partial")), "listing": len(listing),
               "to_fetch": len(to_fetch), "fetched": len(by_id), "errors": len(errors), "triage": dict(triage),
               "attachment_refs": len(as_list(bundle.get("attachments"))), "textdocs_fetched": len(textdocs)}
    return finish_check(args, f, summary, acc_state)


class ThreadTotals:
    def __init__(self):
        self.threads, self.totals, self.ext_totals = [], collections.Counter(), collections.Counter()


def check_thread(cid, conv, row, bundle, cv, f, notes, st):
    """Tree, rendering, outside-object and notes checks for one fetched conversation."""
    textdocs = as_dict(bundle.get("textdocs"))
    title = short(conv.get("title") or row.get("title") or "Untitled", 70)
    scope = "thread %s (%s)" % (cid[:8], title)
    t = tree_check(conv)
    if t["roots"] != 1:
        f.add("FAIL", scope, "mapping has %d roots (expected 1)" % t["roots"])
    if t["unreachable"]:
        f.add("FAIL", scope, "%d mapping node(s) cannot be reached from the root" % t["unreachable"])
    if t["dangling_children"]:
        f.add("FAIL", scope, "%d child reference(s) point at nodes missing from the mapping" % t["dangling_children"])
    if t["parent_mismatch"]:
        f.add("WARN", scope, "%d child link(s) disagree with the child's parent" % t["parent_mismatch"])
    if not t["current_ok"]:
        f.add("FAIL", scope, "current_node is missing from the mapping")
    elif not t["path_reaches_root"]:
        f.add("FAIL", scope, "current_node does not walk back to the root")
    lu, cu = epoch(cv, row.get("update_time")), epoch(cv, conv.get("update_time"))
    if lu and cu and cu + 2 < lu:
        f.add("WARN", scope, "listing says updated %s but the fetched body is older (%s)" % (cv.iso(lu), cv.iso(cu)))
    acc = account_messages(conv, row, bundle, cv, f, scope)
    ext = external_objects(conv)
    if "canvas" in ext:
        fetched = [k for k in ext["canvas"] if k in textdocs]
        if not textdocs and "textdocs" not in bundle:
            f.add("WARN", scope, "%d canvas doc(s) referenced but not fetched (re-pull with fetchTextdocs: true): %s" % (
                len(ext["canvas"]), ", ".join(ext["canvas"])))
        elif len(fetched) < len(ext["canvas"]):
            f.add("FAIL", scope, "%d canvas doc(s) referenced but missing from bundle.textdocs" % (len(ext["canvas"]) - len(fetched)))
    if acc["labels"].get("redacted"):
        f.add("INFO", scope, "%d tool-call stub(s) ChatGPT stored as 'The output of this plugin was redacted.' "
              "(the text is not in the export; a 'Branch in new chat' copy keeps only these stubs)" % acc["buckets"].get("redacted", 0))
    lm = last_visible(conv, t["path"])
    last = (cv.iso(lm.get("create_time")), as_dict(lm.get("author")).get("role")) if lm else None
    entry = {
        "id": cid, "title": title, "triage": row.get("triage"), "update_time": cv.iso(conv.get("update_time")),
        "last_message": last[0] if last else "", "last_role": last[1] if last else "",
        "nodes": t["nodes"], "path_nodes": len(t["path"]), "leaves": t["leaves"], **{k: v for k, v in acc.items() if not k.startswith("_")},
        "external": {k: [dict(id=i, **v) for i, v in d.items()] for k, d in ext.items()},
    }
    if notes is not None:
        got = notes.get(cid)
        if not got:
            f.add("FAIL", scope, "no note in --notes-dir carries this conversation_id")
        elif len(got) > 1:
            f.add("FAIL", scope, "%d notes carry this conversation_id: %s" % (len(got), ", ".join(n for n, _ in got)))
        elif got[0][1] != acc["rendered"]:
            f.add("FAIL", scope, "note %s has %d rendered blocks; convert.py renders %d" % (got[0][0], got[0][1], acc["rendered"]))
        entry["note_blocks"] = got[0][1] if got else None
    st.threads.append(entry)
    st.totals.update({"nodes": t["nodes"], "message_nodes": acc["message_nodes"], "expected_render": acc["expected_render"],
                      "rendered": acc["rendered"], "lost": acc["lost"], "tool_output_truncated": acc["tool_output_truncated"],
                      "tool_output_chars_not_in_notes": acc["tool_output_chars_not_in_notes"],
                      "reasoning_chars_not_in_notes": acc["reasoning_chars_not_in_notes"]})
    for b, n in acc["buckets"].items():
        st.totals["bucket:" + b] += n
    for k, d in ext.items():
        st.ext_totals[k] += len(d)


def finish_check(args, f, summary, st):
    named = collections.defaultdict(collections.Counter)
    for th in st.threads:
        for b in ("hidden", "policy", "empty", "redacted"):
            for label, n in th["labels"].get(b, {}).items():
                named[b][label] += n
    result = {
        "ok": f.count("FAIL") == 0, "fails": f.count("FAIL"), "warnings": f.count("WARN"),
        "bundle": summary, "totals": dict(st.totals), "external_totals": dict(st.ext_totals),
        "named_gaps": {k: dict(v) for k, v in named.items()},
        "findings": f.items, "threads": sorted(st.threads, key=lambda x: x["update_time"], reverse=True),
    }
    if args.report_md:
        write_report(args.report_md, result)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print_human(result, args.verbose)
    return 0 if result["ok"] else EXIT_FAIL


# ---------------------------------------------------------------- account pulls (schema-3 parts)

def expand(cv, inputs):
    try:
        return cv.expand_inputs(inputs)
    except cv.PartError as e:
        die(str(e))


def read_headers(cv, paths, max_mb):
    """Pass 1: read each part once and keep only its header (one part in memory at a time)."""
    headers = []
    for p in paths:
        try:
            b, sha, size, _ = cv.read_json_file(p, max_mb)
        except cv.PartError as e:
            die(str(e))
        if not cv.is_account_part(b):
            die("%s is not an account part (schema 3): check project and thread bundles one at a time" % os.path.basename(p))
        headers.append(cv.part_header(b, p, sha, size))
        del b
    return headers


def run_check_account(args, cv, paths):
    f = Findings()
    headers = read_headers(cv, paths, args.max_input_mb)
    plan = cv.account_plan(headers, part_only=args.part_only)
    for level, scope, msg in plan["problems"]:
        f.add(level, scope, msg)
    if args.expected_count is not None and args.expected_count != len(plan["listing"]):
        f.add("FAIL", "listing", "listing has %d threads but %d were expected" % (len(plan["listing"]), args.expected_count))
    notes = notes_counts(args.notes_dir) if args.notes_dir else None
    st = ThreadTotals()
    done = set()
    # pass 2: per-thread checks on the copy convert.py renders (the latest one), one part in memory at a time
    for rid, hs in plan["order"]:
        for h in hs:
            if not any(plan["winner"].get(cid) == (rid, h["part"]) for cid in h["conv_ids"]):
                continue
            b, _, _, _ = cv.read_json_file(h["path"], args.max_input_mb)
            for conv in as_list(b.get("conversations")):
                cid = cv.conv_key(conv) if isinstance(conv, dict) else None
                if cid is None or cid in done or plan["winner"].get(cid) != (rid, h["part"]):
                    continue
                done.add(cid)
                check_thread(cid, conv, plan["rows"].get(cid, {}), b, cv, f, notes, st)
            del b
    if notes is not None:
        stray = [cid for cid in notes if cid not in plan["winner"]]
        if stray:
            f.add("FAIL", "notes", "%d note(s) in --notes-dir belong to conversations not in these parts" % len(stray))
    listing = plan["listing"]
    first = plan["order"][0][1][0] if plan["order"] else {}
    summary = {"kind": "account", "project": None, "pulled_at": plan["pulled_at"], "started_at": plan["started_at"],
               "since": plan["since"], "stop_reason": first.get("stop_reason"), "partial": not plan["complete"],
               "listing": len(listing), "to_fetch": len(plan["to_fetch"]), "fetched": len(plan["winner"]),
               "errors": len(plan["errors_unresolved"]), "triage": dict(collections.Counter(r.get("triage") or "-" for r in listing)),
               "attachment_refs": sum(h["attachment_count"] for h in headers),
               "textdocs_fetched": sum(h["textdoc_count"] for h in headers),
               "run": plan["primary"], "resume_runs": [rid for rid, _ in plan["order"][1:]], "parts": len(headers),
               "missing": len(plan["missing"]), "capped": plan["capped"],
               "sources": {k: as_dict(as_dict(plan["sources"]).get(k)).get("stop_reason") for k in cv.REQUIRED_SOURCES}}
    return finish_check(args, f, summary, st)


def run_missing(args):
    """Print the to-fetch ids that are in no part, as a JSON array that pastes straight into CFG.onlyIds."""
    cv = load_convert(args.convert)
    headers = read_headers(cv, expand(cv, args.input), args.max_input_mb)
    plan = cv.account_plan(headers)
    if plan["fatal"]:
        for m in plan["fatal"]:
            print("verify.py: " + m, file=sys.stderr)
        return EXIT_FAIL
    ids = [i for i in plan["missing"] if isinstance(i, str) and cv.UUID_RE.fullmatch(i)]
    if len(ids) < len(plan["missing"]):
        print("verify.py: %d missing id(s) are not uuids and were left out" % (len(plan["missing"]) - len(ids)), file=sys.stderr)
    total = len(ids)
    if args.limit:
        ids = ids[:args.limit]
    last_status = {}
    for _, hs in plan["order"]:
        for h in hs:
            for e in h["errors"]:
                last_status[e.get("id")] = e.get("status")
    errored = collections.Counter(str(last_status[i]) for i in ids if i in last_status)
    print(json.dumps(ids))
    src = as_dict(plan["sources"])
    bad = [k for k in cv.REQUIRED_SOURCES if as_dict(src.get(k)).get("stop_reason") not in ("complete", "since_cutoff")]
    if bad or any(as_dict(v).get("stop_reason") != "complete" for v in as_dict(src.get("project_threads")).values()):
        print("verify.py: the pull's listing is incomplete (%s); these are only the gaps in what was listed"
              % (", ".join(bad) or "a project listing"), file=sys.stderr)
    if total:
        print("verify.py: %d of %d to-fetch thread(s) are in no part (%d printed). Next run: CFG.onlyIds = the array "
              "above, CFG.resumeOf = '%s'%s" % (total, len(plan["to_fetch"]), len(ids), plan["primary"],
                                               "; last error per id: " + fmt_counter(errored) if errored else ""), file=sys.stderr)
    else:
        print("verify.py: nothing missing: every to-fetch thread of %s is in a part" % plan["primary"], file=sys.stderr)
    return 0


def since_account(args):
    """Newest complete account pull in the archive dir. Runs are found by file name and read newest first, so a
    weekly run reads only the latest pull's parts. A resume run is read before (newer than) the pull it resumes."""
    cv = load_convert(args.convert)
    real = os.path.realpath(args.archive_dir)
    by_run = collections.defaultdict(list)
    for name in sorted(os.listdir(real)):
        m = cv.PART_NAME_RE.fullmatch(name)
        if m:
            by_run[m.group(1)].append(os.path.join(real, name))
    resumes = collections.defaultdict(list)
    for rid in sorted(by_run, reverse=True):
        hs = read_headers(cv, by_run[rid], args.max_input_mb)
        ro = hs[0].get("resume_of")
        if ro:
            resumes[ro].extend(hs)
            continue
        plan = cv.account_plan(hs + resumes.get(rid, []))
        if plan["complete"] and isinstance(plan["started_at"], str):
            print(plan["started_at"])
            return 0
    die("no complete account pull in %s" % args.archive_dir, EXIT_FAIL)


def print_human(r, verbose):
    b, t = r["bundle"], r["totals"]
    print("ai-export verify: %s" % ("PASS" if r["ok"] else "FAIL (%d)" % r["fails"]))
    print("  %s %s, pulled %s%s" % (b["kind"], b["project"] or b.get("run") or "", b["pulled_at"], ", since %s" % b["since"] if b["since"] else ""))
    if b["kind"] == "account":
        print("  parts %d · resume runs %d · missing %d%s · sources %s" % (
            b["parts"], len(b["resume_runs"]), b["missing"], " (capped)" if b["capped"] else "",
            ", ".join("%s %s" % kv for kv in b["sources"].items())))
    print("  listing %d (stop: %s, partial: %s) · fetched %d/%d · errors %d · triage %s" % (
        b["listing"], b["stop_reason"] or "n/a", b["partial"], b["fetched"], b["to_fetch"], b["errors"],
        ", ".join("%s %d" % kv for kv in sorted(b["triage"].items()))))
    print("  nodes %d · message nodes %d · rendered %d of %d expected · lost %d" % (
        t.get("nodes", 0), t.get("message_nodes", 0), t.get("rendered", 0), t.get("expected_render", 0), t.get("lost", 0)))
    print("  left out on purpose: %s" % ", ".join("%s %d" % (k[7:], v) for k, v in sorted(t.items()) if k.startswith("bucket:") and k[7:] not in ("render", "no_message")))
    print("  tool output cut to fit notes: %d messages, %d chars (kept in the raw archive) · reasoning not in notes: %d chars" % (
        t.get("tool_output_truncated", 0), t.get("tool_output_chars_not_in_notes", 0), t.get("reasoning_chars_not_in_notes", 0)))
    if r["external_totals"]:
        print("  outside the conversation JSON: %s" % ", ".join("%s %d" % kv for kv in sorted(r["external_totals"].items())))
    for level in ("FAIL", "WARN", "INFO"):
        rows = [i for i in r["findings"] if i["level"] == level]
        if level == "INFO" and not verbose and len(rows) > 6:
            print("INFO: %d notes (use --verbose)" % len(rows))
            continue
        for i in rows:
            print("%s: [%s] %s" % (level, i["scope"], i["msg"]))
    if verbose:
        for k, v in r["named_gaps"].items():
            print("named %s: %s" % (k, fmt_counter(collections.Counter(v), 20)))


def md_cell(s):
    return short(s, 90).replace("|", "/")


def write_report(path, r):
    real = os.path.realpath(path)
    os.makedirs(os.path.dirname(real), exist_ok=True)
    b, t = r["bundle"], r["totals"]
    lines = ["# ai-export run report", "",
             "**Verdict: %s.** %s %s, pulled `%s`%s." % (
                 "PASS" if r["ok"] else "FAIL (%d)" % r["fails"], b["kind"], "`%s`" % (b["project"] or b.get("run")) if (b["project"] or b.get("run")) else "",
                 b["pulled_at"], ", incremental since `%s`" % b["since"] if b["since"] else ""), "",
             "| Check | Result |", "|---|---|",
             "| Listing | %d threads, stop reason `%s`, partial %s |" % (b["listing"], b["stop_reason"] or "n/a", b["partial"]),
             "| Triage | %s |" % (", ".join("%s %d" % kv for kv in sorted(b["triage"].items())) or "-"),
             "| Fetched | %d of %d, %d errors |" % (b["fetched"], b["to_fetch"], b["errors"]),
             *(["| Parts | %d, resume runs %d, missing %d%s |" % (b["parts"], len(b["resume_runs"]), b["missing"],
                                                                " (capped)" if b["capped"] else "")] if b["kind"] == "account" else []),
             "| Messages rendered | %d of %d expected (%d lost) |" % (t.get("rendered", 0), t.get("expected_render", 0), t.get("lost", 0)),
             "| Left out on purpose | %s |" % ", ".join("%s %d" % (k[7:], v) for k, v in sorted(t.items()) if k.startswith("bucket:") and k[7:] not in ("render", "no_message")),
             "| Tool output cut in notes | %d messages, %d chars (in the raw archive) |" % (t.get("tool_output_truncated", 0), t.get("tool_output_chars_not_in_notes", 0)),
             "| Outside the conversation JSON | %s |" % (", ".join("%s %d" % kv for kv in sorted(r["external_totals"].items())) or "none"),
             ""]
    fails = [i for i in r["findings"] if i["level"] in ("FAIL", "WARN")]
    if fails:
        lines += ["## Findings", ""] + ["- **%s** %s: %s" % (i["level"], md_cell(i["scope"]), i["msg"]) for i in fails] + [""]
    lines += ["## Threads", "", "| Thread | Triage | Updated | Last message | Rendered | Outside JSON |", "|---|---|---|---|---|---|"]
    for th in r["threads"]:
        ext = ", ".join("%s %d" % (k, len(v)) for k, v in sorted(th["external"].items()))
        lines.append("| %s | %s | %s | %s | %d/%d | %s |" % (md_cell(th["title"]), th["triage"] or "-", th["update_time"][:16],
                                                        th["last_message"][:16], th["rendered"], th["expected_render"], ext or "-"))
    with open(real, "x", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


# ---------------------------------------------------------------- spot check

def run_spot(args):
    cv = load_convert(args.convert)
    bundle = read_bundle(args.input, args.max_input_mb)
    conv = next((c for c in as_list(bundle.get("conversations")) if isinstance(c, dict)
                 and (c.get("conversation_id") or c.get("id")) == args.thread), None)
    if conv is None:
        die("thread %s is not in the bundle" % args.thread, EXIT_FAIL)
    t = tree_check(conv)
    mapping = as_dict(conv.get("mapping"))
    last = last_visible(conv, t["path"])
    project = bundle.get("project") if isinstance(bundle.get("project"), str) and PROJECT_RE.fullmatch(bundle.get("project")) else None
    if bundle.get("kind") == "account":   # an account part: the thread's own project, from the listing
        row = next((r for r in as_list(bundle.get("listing")) if isinstance(r, dict) and r.get("id") == args.thread), {})
        project = row.get("project") if isinstance(row.get("project"), str) and PROJECT_RE.fullmatch(row["project"]) else None
    mine = {"id": args.thread, "title": short(conv.get("title"), 80), "update_time": cv.iso(conv.get("update_time")),
            "current_node": conv.get("current_node"), "nodes": t["nodes"], "path_nodes": len(t["path"]),
            "last_message_time": cv.iso(last.get("create_time")) if last else "", "last_message_role": as_dict(as_dict(last).get("author")).get("role") if last else "",
            "url": ("https://chatgpt.com/g/%s/c/%s" % (project, args.thread)) if project else "https://chatgpt.com/c/%s" % args.thread}
    print(json.dumps({"bundle": mine}, indent=2))
    if not args.live:
        print("Open the URL, check the last message's time and the thread's last activity against the values above, "
              "or run spot-check.js in that tab and pass its output with --live.")
        return 0
    with open(os.path.realpath(args.live), encoding="utf-8") as fh:
        live = json.loads(fh.read(1_000_000))
    live = as_dict(live)
    fails = []
    lu, bu = cv.to_epoch(live.get("update_time")), cv.to_epoch(conv.get("update_time"))
    if lu and bu and lu > bu + 2:
        fails.append("live thread updated %s, after the bundle's %s: it has grown since the pull" % (cv.iso(lu), cv.iso(bu)))
    if live.get("current_node") and live.get("current_node") != conv.get("current_node"):
        fails.append("live current_node differs (a new message or a different branch is selected)")
    if isinstance(live.get("nodes"), int) and live["nodes"] != t["nodes"]:
        fails.append("live mapping has %d nodes, bundle %d" % (live["nodes"], t["nodes"]))
    if live.get("last_message_time") and mine["last_message_time"] and cv.iso(live["last_message_time"]) != mine["last_message_time"]:
        fails.append("last message time differs: live %s, bundle %s" % (cv.iso(live["last_message_time"]), mine["last_message_time"]))
    for msg in fails:
        print("FAIL: " + msg)
    print("spot check: %s" % ("PASS" if not fails else "FAIL"))
    return 0 if not fails else EXIT_FAIL


# ---------------------------------------------------------------- since

PULLED_RE = re.compile(r"^Pulled (\d{4}-\d{2}-\d{2}T[0-9:.]+Z) from the ChatGPT web app", re.M)
CUTOFF_RE = re.compile(r"^\| Next --since cutoff \| `(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)` \|", re.M)


def run_since(args):
    """Print the cutoff for the next incremental pull: the newest complete pull's started_at (else pulled_at)."""
    if args.index_note:
        with open(os.path.realpath(args.index_note), encoding="utf-8") as fh:
            text = fh.read(2_000_000)
        m = CUTOFF_RE.search(text) or PULLED_RE.search(text)
        if not m:
            die("no pull time found in %s" % args.index_note, EXIT_FAIL)
        if not CUTOFF_RE.search(text):
            print("verify.py: index note has no recorded listing start; using its pull time (threads updated during that "
                  "pull may be classed unchanged)", file=sys.stderr)
        print(m.group(1))
        return 0
    if args.archive_dir and args.account and not args.project:
        return since_account(args)
    if not (args.archive_dir and args.project) or args.account:
        die("since needs --index-note, or --archive-dir with exactly one of --project / --account")
    real = os.path.realpath(args.archive_dir)
    best = None
    for name in sorted(os.listdir(real)):
        if not re.fullmatch(r"[A-Za-z0-9._-]+\.json(?:\.gz)?", name) or ACCOUNT_PART_NAME_RE.fullmatch(name):
            continue   # account parts can never be this project's pull, and they are large: skip without reading
        b = read_bundle(os.path.join(real, name), args.max_input_mb)
        if b.get("project") != args.project or b.get("partial") or b.get("list_only") or b.get("errors"):
            continue
        cut = b.get("started_at") or b.get("pulled_at")
        if isinstance(cut, str) and (best is None or cut > best[0]):
            best = (cut, name, "started_at" if b.get("started_at") else "pulled_at")
    if not best:
        die("no complete pull of %s in %s" % (args.project, args.archive_dir), EXIT_FAIL)
    if best[2] == "pulled_at":
        print("verify.py: %s predates started_at; using pulled_at (threads updated during that pull may be classed "
              "unchanged; pass fetchUnchanged or an earlier --since if that matters)" % best[1], file=sys.stderr)
    print(best[0])
    return 0


def main():
    ap = argparse.ArgumentParser(description="Completeness checks for ai-export ChatGPT bundles.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    here = os.path.join(os.path.dirname(os.path.realpath(__file__)), "convert.py")
    for name in ("check", "spot", "since", "missing"):
        p = sub.add_parser(name)
        p.add_argument("--max-input-mb", type=int, default=MAX_INPUT_MB)
        p.add_argument("--convert", default=here, help="convert.py to measure rendering with")
    for name in ("check", "missing"):
        sub.choices[name].add_argument("--input", required=True, action="append",
                                       help="bundle JSON or .json.gz (untrusted); repeat per account part, or pass their directory")
    sub.choices["spot"].add_argument("--input", required=True, help="bundle JSON or .json.gz (untrusted)")
    c = sub.choices["check"]
    c.add_argument("--expected-count", type=int, help="thread count the project page shows")
    c.add_argument("--notes-dir", help="convert.py output dir to cross-check rendered block counts")
    c.add_argument("--report-md", help="write a short markdown run report here (never overwrites)")
    c.add_argument("--part-only", action="store_true", help="account parts: report missing parts and threads as INFO")
    c.add_argument("--json", action="store_true")
    c.add_argument("--verbose", action="store_true")
    s = sub.choices["spot"]
    s.add_argument("--thread", required=True)
    s.add_argument("--live", help="JSON from spot-check.js run in the thread's tab")
    n = sub.choices["since"]
    n.add_argument("--archive-dir")
    n.add_argument("--project")
    n.add_argument("--account", action="store_true", help="newest complete account pull in --archive-dir")
    n.add_argument("--index-note")
    m = sub.choices["missing"]
    m.add_argument("--limit", type=int, help="print at most this many ids (one run's worth, e.g. its maxThreads)")
    args = ap.parse_args()
    if getattr(args, "thread", None) and not CONV_ID_RE.fullmatch(args.thread):
        die("--thread must be a conversation id")
    if getattr(args, "limit", None) is not None and args.limit < 1:
        die("--limit must be at least 1")
    sys.exit({"check": run_check, "spot": run_spot, "since": run_since, "missing": run_missing}[args.cmd](args))


if __name__ == "__main__":
    main()
